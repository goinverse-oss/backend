const serverless = require('serverless-http');
const bodyParser = require('body-parser');
const express = require('express');
const qs = require('qs');
const axios = require('axios');
const helmet = require('helmet');
const morgan = require('morgan');
const _ = require('lodash');
const Sentry = require('@sentry/node');
const { patreon: patreonAPI } = require('patreon');

const { getCreds } = require('./src/creds');

const stage = process.env.SLS_STAGE;

function canAccess(pledge, item, podcasts) {
  const contentType = item.sys.contentType.sys.id;
  if (contentType === 'podcastEpisode') {
    const podcast = podcasts[item.fields.podcast.sys.id];
    return (
      _.get(podcast.fields, 'minimumPledgeDollars', null) === null
        || (
          !!pledge
            && podcast.fields.minimumPledgeDollars * 100 <= pledge.amount_cents
        )
    );
  }
  if (contentType === 'meditation' || contentType === 'liturgyItem') {
    // Patrons with the 'Master Meditations' reward tier
    // get access to both Meditations and Liturgies
    // in addition to patrons-only podcasts.
    return (
      pledge && /Meditations/i.test(pledge.reward.title)
    );
  }
  return true;
}

async function filterData(contentfulData, patreon) {
  let pledge = null;

  if (patreon.token) {
    const client = patreonAPI(patreon.token);
    const { store, rawJson } = await client('/current_user?includes=pledges');
    const user = store.find('user', rawJson.data.id);

    pledge = _.find(user.pledges, p => (p.reward.campaign.url === patreon.campaign_url));
  }

  // podcasts are included; pull them out by ID first
  const podcasts = _.fromPairs(
    contentfulData.includes.Entry.filter(
      entry => entry.sys.contentType.sys.id === 'podcast',
    ).map(podcast => ([podcast.sys.id, podcast])),
  );

  return {
    ...contentfulData,
    items: contentfulData.items.map(
      (item) => {
        if (canAccess(pledge, item, podcasts)) {
          return _.set(item, 'fields.patronsOnly', false);
        }

        const filteredItem = item.fields.isFreePreview
          ? item
          : _.omit(item, ['fields.media', 'fields.mediaUrl']);

        // `patronsOnly` tells the app that the user can't access this item
        // because they're not a patron or haven't pledged enough.
        // `isFreePreview` tells the app to put a little "Free Preview"
        // label on items that wouldn't have been ordinarily accessible but are
        // given as preview media.
        return _.set(filteredItem, 'fields.patronsOnly', true);
      },
    ),
  };
}

function wrapAsync(fn) {
  // Async exceptions result in uncaught rejected promises,
  // which bypass Express' error handling and crash the lambda.
  // This ensures any uncaught exception gets passed to next()
  // which lets Express handle it.
  return (req, res, next) => (
    fn(req, res, next).catch(next)
  );
}

const patreonBaseUrl = 'https://www.patreon.com/';
const patreonAuthUrl = `${patreonBaseUrl}/oauth2/authorize`;
const patreonTokenUrl = `${patreonBaseUrl}/api/oauth2/token`;

async function init() {
  const sentry = await getCreds('sentry');

  Sentry.init(sentry);
  Sentry.configureScope((scope) => {
    scope.setTag('stage', stage);
  });

  Sentry.addBreadcrumb({ message: 'Setting up Express app' });

  const app = express();
  app.use(Sentry.Handlers.requestHandler());
  app.use(Sentry.Handlers.errorHandler());

  app.use(morgan('combined'));
  app.use(helmet());

  // Initialize OAuth2 flow, redirecting to Patreon with client_id
  app.get(
    '*/patreon/authorize',
    wrapAsync(
      async (req, res) => {
        const patreon = await getCreds('patreon');

        const obj = {
          ...req.query,
          client_id: patreon.client_id,
        };
        const query = qs.stringify(obj);
        res.status(302).redirect(`${patreonAuthUrl}?${query}`);
      },
    ),
  );

  // Send code to Patreon and receive token
  app.post(
    '*/patreon/validate',
    bodyParser.urlencoded({ extended: true }),
    wrapAsync(
      async (req, res) => {
        const patreon = await getCreds('patreon');

        const url = patreonTokenUrl;

        const obj = {
          ...req.body,
          ..._.pick(patreon, ['client_id', 'client_secret']),
        };
        const body = qs.stringify(obj);
        const patreonRes = await axios.post(url, body, { validateStatus: null });
        res.status(patreonRes.status).json(patreonRes.data);
      },
    ),
  );

  /**
   * Fetch contentful data, filtered by Patreon access.
   *
   * @param {string} path contentful resource path (after environment)
   * @param {object} params contentful query params from request object
   * @param {string} patreonToken patreon token from request header
   * @returns {object} contentful API response
   * @throws {Error} on contentful API error
   *   error object has 'status' and 'json' fields
   */
  async function contentfulGet(path, params, patreonToken) {
    const contentful = await getCreds('contentful');
    const { space, environment } = contentful;
    const { campaign_url: patreonCampaignUrl } = await getCreds('patreon');

    const fullPath = `/spaces/${space}/environments/${environment}/${path}`;
    const host = 'https://cdn.contentful.com';
    const url = `${host}/${fullPath}`;
    Sentry.addBreadcrumb({ message: 'Making contentful request', data: url });
    const contentfulRes = await axios.get(url, {
      params,
      validateStatus: null,
      headers: {
        authorization: `Bearer ${contentful.accessToken}`,
      },
    });
    const patreon = {
      token: patreonToken,
      campaign_url: patreonCampaignUrl,
    };
    const { status } = contentfulRes;
    const { data } = contentfulRes;
    Sentry.addBreadcrumb({ message: 'Got contentful response', data });

    if (status >= 400) {
      const e = new Error();
      e.status = status;
      e.json = data;
      throw e;
    }

    try {
      return await filterData(data, patreon);
    } catch (e) {
      e.json = {
        error: (
          'Error verifying Patreon status. '
          + 'Please re-connect Patreon and try again.'
        ),
      };
      throw e.error;
    }
  }

  app.get('*/contentful/spaces/:space/environments/:env/*', wrapAsync(
    async (req, res) => {
      Sentry.addBreadcrumb({ message: 'API request', data: req.path });

      const path = req.params[1];
      const params = req.query;
      const patreonToken = _.get(req.headers, 'x-theliturgists-patreon-token');

      try {
        const data = await contentfulGet(path, params, patreonToken);
        res.status(200).json(data);
      } catch (e) {
        console.log(e);
        res.status(e.status).json(e.json);
      }
    },
  ));

  app.use(
    // eslint-disable-next-line
    async (error, req, res, next) => {
      console.error('Uncaught error:', error);

      // force sentry to flush any buffered eents
      Sentry.captureException(error);
      await Sentry.getCurrentHub().getClient().close(2000);

      res.status(500).json({
        error: _.pick(error, ['message', 'stack']),
      });
    },
  );

  return app;
}

let handler;

module.exports.init = init;
module.exports.handler = async (event, context) => {
  try {
    if (!handler) {
      Sentry.addBreadcrumb({ message: 'Initializing handler' });
      const app = await init();
      handler = serverless(app);
    }
  } catch (err) {
    console.error('Uncaught error in init:', err);
    Sentry.captureException(err);

    throw err;
  }

  Sentry.addBreadcrumb({ message: 'Handling http event', data: event });

  // does its own error handling
  return handler(event, context);
};
