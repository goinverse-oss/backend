const serverless = require('serverless-http');
const bodyParser = require('body-parser');
const express = require('express');
const qs = require('qs');
const awsParamStore = require('aws-param-store');
const axios = require('axios');
const helmet = require('helmet');
const morgan = require('morgan');
const _ = require('lodash');
const Sentry = require('@sentry/node');
const { patreon: patreonAPI } = require('patreon');

const stage = process.env.SLS_STAGE;

const credSpecs = {
  patreon: {
    client_id: `/${stage}/PATREON_CLIENT_ID`,
    client_secret: `/${stage}/PATREON_CLIENT_SECRET`,
    campaign_url: `/${stage}/PATREON_CAMPAIGN_URL`,
  },
  contentful: {
    space: `/${stage}/CONTENTFUL_SPACE`,
    environment: `/${stage}/CONTENTFUL_ENVIRONMENT`,
    accessToken: `/${stage}/CONTENTFUL_ACCESS_TOKEN`,
  },
  sentry: {
    dsn: `/${stage}/SENTRY_DSN`,
  },
};

async function getCreds(name) {
  const credSpec = credSpecs[name];
  const opts = { region: process.env.AWS_REGION };
  const keys = _.keys(credSpec);
  const params = await Promise.all(
    keys.map(key => awsParamStore.getParameter(credSpec[key], opts)),
  );
  const values = _.map(params, 'Value');
  return _.zipObject(keys, values);
}

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
  if (contentType === 'meditation') {
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

  app.get('*/contentful/*', wrapAsync(
    async (req, res) => {
      const contentful = await getCreds('contentful');

      Sentry.addBreadcrumb({ message: 'API request', data: req.path });
      const path = req.path
        .replace(new RegExp(`^(/${stage})?/contentful`), '')
        .replace(/\/spaces\/[^/]+/, `/spaces/${contentful.space}`)
        .replace(/\/environments\/[^/]+/, `/environments/${contentful.environment}`);
      const host = 'https://cdn.contentful.com';
      const url = `${host}/${path}`;
      Sentry.addBreadcrumb({ message: 'Making contentful request', data: url });
      const contentfulRes = await axios.get(url, {
        params: req.query,
        validateStatus: null,
        headers: {
          authorization: `Bearer ${contentful.accessToken}`,
        },
      });
      const patreonAuth = {
        token: _.get(req.headers, 'x-theliturgists-patreon-token'),
      };
      const { status } = contentfulRes;
      let { data } = contentfulRes;
      Sentry.addBreadcrumb({ message: 'Got contentful response', data });

      let patreonError;
      if (status >= 200 && status < 300) {
        try {
          data = await filterData(data, patreonAuth);
        } catch (e) {
          patreonError = e.error;
        }
      }
      if (patreonError) {
        res.status(patreonError.status).json({
          error: (
            'Error verifying Patreon status. '
            + 'Please re-connect Patreon and try again.'
          ),
        });
      } else {
        res.status(status).json(data);
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
