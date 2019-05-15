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
const RSS = require('rss');
const striptags = require('striptags');

const { getCreds } = require('./src/creds');

const stage = process.env.SLS_STAGE;

function canAccessPodcast(pledge, podcast) {
  return (
    _.get(podcast.fields, 'minimumPledgeDollars', null) === null
      || (
        !!pledge
          && podcast.fields.minimumPledgeDollars * 100 <= pledge.amount_cents
      )
  );
}

function canAccessPatronMedia(pledge) {
  // Patrons with the 'Master Meditations' reward tier
  // get access to both Meditations and Liturgies
  // in addition to patrons-only podcasts.
  return pledge && /Meditations/i.test(pledge.reward.title);
}

function canAccess(pledge, item, podcasts) {
  const contentType = _.get(item, 'sys.contentType.sys.id');
  if (contentType === 'podcastEpisode') {
    const podcast = podcasts[item.fields.podcast.sys.id];
    return canAccessPodcast(pledge, podcast);
  }
  if (contentType === 'meditation' || contentType === 'liturgyItem') {
    return canAccessPatronMedia(pledge);
  }
  return true;
}

async function getPledge(patreon) {
  const { token, campaignUrl } = patreon;
  if (!token || !campaignUrl) {
    return null;
  }

  const client = patreonAPI(token);
  let resp;
  try {
    resp = await client('/current_user?includes=pledges');
  } catch (patreonError) {
    try {
      // patreonError.response is a response object from fetch()
      const patreonResponse = await patreonError.response.json();
      console.log(`Patreon error: ${JSON.stringify(patreonResponse, null, 2)}`);
    } catch (e) {
      console.log(`Error retrieving Patreon error: ${e}`);
    }

    // no matter what the error was, deny access.
    return null;
  }

  const { store, rawJson } = resp;
  const user = store.find('user', rawJson.data.id);

  return _.find(
    user.pledges,
    p => (p.reward.campaign.url === campaignUrl),
  );
}

function filterEntry(entry, pledge, podcasts) {
  if (canAccess(pledge, entry, podcasts)) {
    return _.set(entry, 'fields.patronsOnly', false);
  }

  const filteredEntry = entry.fields.isFreePreview
    ? entry
    : _.omit(entry, ['fields.media', 'fields.mediaUrl']);

  // `patronsOnly` tells the app that the user can't access this entry
  // because they're not a patron or haven't pledged enough.
  // `isFreePreview` tells the app to put a little "Free Preview"
  // label on entries that wouldn't have been ordinarily accessible but are
  // given as preview media.
  return _.set(filteredEntry, 'fields.patronsOnly', true);
}

async function filterData(contentfulData, patreon) {
  const pledge = await getPledge(patreon);

  if (!_.has(contentfulData, 'items')) {
    // this is not an entry set; it's a single entry
    return filterEntry(contentfulData, pledge, {});
  }

  // podcasts are included; pull them out by ID first
  const includedEntries = _.get(contentfulData, 'includes.Entry', []);
  const podcasts = _.fromPairs(
    includedEntries.filter(
      entry => entry.sys.contentType.sys.id === 'podcast',
    ).map(podcast => ([podcast.sys.id, podcast])),
  );

  const d = {
    ...contentfulData,
    items: contentfulData.items.map(item => filterEntry(item, pledge, podcasts)),
  };
  return d;
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
  async function contentfulGet(path, params, patreonToken, filter = true) {
    const contentful = await getCreds('contentful');
    const { space, environment } = contentful;
    const { campaign_url: campaignUrl } = await getCreds('patreon');

    const fullPath = `/spaces/${space}/environments/${environment}/${path}`;
    const host = 'https://cdn.contentful.com';
    const url = `${host}/${fullPath}`;
    Sentry.addBreadcrumb({
      message: 'Making contentful request',
      data: { url },
    });
    const contentfulRes = await axios.get(url, {
      params,
      validateStatus: null,
      headers: {
        authorization: `Bearer ${contentful.accessToken}`,
      },
    });
    const patreon = {
      token: patreonToken,
      campaignUrl,
    };
    const { status, data } = contentfulRes;
    Sentry.addBreadcrumb({ message: 'Got contentful response', data: { json: data } });

    if (status >= 400) {
      const e = new Error();
      e.status = status;
      e.json = data;
      throw e;
    }

    if (!filter) {
      return data;
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
      throw e;
    }
  }

  app.get('*/contentful/spaces/:space/environments/:env/*', wrapAsync(
    async (req, res) => {
      Sentry.addBreadcrumb({ message: 'API request', data: req.path });

      const path = req.params[1]; // second wildcard match
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

  async function canAccessFeed(collectionObj, patreon) {
    const pledge = await getPledge(patreon);
    if (collectionObj.sys.contentType.sys.id === 'podcast') {
      return canAccessPodcast(pledge, collectionObj);
    }
    return canAccessPatronMedia(pledge);
  }

  function getImageUrl(collectionObj) {
    let url = _.get(collectionObj, 'fields.image.file.url');
    if (!url) {
      url = _.get(collectionObj, 'fields.imageUrl');
    }
    return url;
  }

  function getMediaUrl(entry) {
    let url = _.get(entry, 'fields.media.file.url');
    if (!url) {
      url = _.get(entry, 'fields.mediaUrl');
    }
    return url;
  }

  function imageElementIfDefined(entry) {
    const href = getImageUrl(entry);
    if (!href) {
      return [];
    }

    return [
      { 'itunes:image': { _attr: { href } } },
    ];
  }

  function getFullRequestUrl(req) {
    const { hostname, path } = req;
    const prefix = /execute-api/.test(hostname) ? `/${stage}` : '';
    return `https://${hostname}${prefix}${path}`;
  }

  app.get('*/rss/:collection/:collectionId', wrapAsync(
    async (req, res) => {
      const { collection, collectionId } = req.params;
      const collectionFields = {
        podcast: 'podcast',
        'meditation-category': 'category',
      };
      if (!_.has(collectionFields, collection)) {
        throw new Error(`invalid collection '${collection}'`);
      }

      const collectionField = collectionFields[collection];
      const itemType = {
        podcast: 'podcastEpisode',
        category: 'meditation',
      }[collectionField];

      const { campaign_url: campaignUrl } = await getCreds('patreon');
      const patreon = {
        token: _.get(req.query, 'patreonToken'),
        campaignUrl,
      };
      const collectionObj = await contentfulGet(
        `entries/${collectionId}`,
        {},
        patreon.token,
        false,
      );
      const access = await canAccessFeed(collectionObj, patreon);
      if (!access) {
        res.status(401).send('feed access denied');
        return;
      }
      if (collectionObj.fields.feedUrl) {
        res.redirect(collectionObj.fields.feedUrl);
        return;
      }

      if (collectionObj.fields.image) {
        const assetId = collectionObj.fields.image.sys.id;
        const imageAsset = await contentfulGet(`assets/${assetId}`, {});
        imageAsset.fields.file.url = `https:${imageAsset.fields.file.url}`;
        collectionObj.fields.image = _.pick(imageAsset.fields, ['file', 'title']);
      }

      const params = {
        content_type: itemType,
        [`fields.${collectionField}.sys.id`]: collectionId,
        order: '-fields.publishedAt',
      };
      const data = await contentfulGet('entries', params, patreon.token);
      const category = 'Religion & Spirituality';
      const author = 'The Liturgists Network';
      const feed = new RSS({
        title: collectionObj.fields.title,
        description: collectionObj.fields.description,
        feed_url: getFullRequestUrl(req),
        site_url: 'https://theliturgists.com',
        image_url: getImageUrl(collectionObj),
        language: 'en-US',
        categories: [category],
        pubDate: _.get(data.items, [0, 'fields', 'publishedAt'], null),
        custom_namespaces: {
          itunes: 'http://www.itunes.com/dtds/podcast-1.0.dtd',
          googleplay: 'http://www.google.com/schemas/play-podcasts/1.0',
        },
        custom_elements: [
          { 'itunes:block': 'yes' },
          { 'googleplay:block': 'yes' },
          { 'itunes:summary': striptags(collectionObj.fields.description) },
          { 'itunes:author': author },
          {
            'itunes:owner': [
              { 'itunes:name': author },
              { 'itunes:email': 'app@theliturgists.com' },
            ],
          },
          {
            'itunes:image': {
              _attr: { href: getImageUrl(collectionObj) },
            },
          },
          {
            'itunes:category': {
              _attr: { text: category },
            },
          },
        ],
      });

      // TODO: handle contentful pagination
      data.items.forEach((entry) => {
        feed.item({
          guid: entry.sys.id,
          title: entry.fields.title,
          description: entry.fields.description,
          date: entry.fields.publishedAt,
          enclosure: {
            url: getMediaUrl(entry),
            type: 'audio/mpeg',
          },
          image_url: getImageUrl(entry),
          custom_elements: [
            ...imageElementIfDefined(entry),
            { 'itunes:duration': entry.fields.duration },
            { 'itunes:summary': striptags(entry.fields.description) },
            { 'itunes:subtitle': striptags(entry.fields.description) },
            {
              'content:encoded': {
                _cdata: entry.fields.description,
              },
            },
          ],
        });
      });
      const xml = feed.xml({ indent: true });
      res.set('Content-type', 'application/rss+xml');
      res.status(200).send(xml);
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
