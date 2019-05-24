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
const uuidv4 = require('uuid/v4');
const jwt = require('jsonwebtoken');
const moment = require('moment');
const urlParse = require('url-parse');

const { getCreds } = require('./src/creds');
const TokenMapping = require('./src/TokenMapping');

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
  const title = _.get(pledge, 'reward.title');
  return title && /Meditations/i.test(title);
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

async function getPatreonUser(token) {
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
  return store.find('user', rawJson.data.id);
}

async function getPledge(patreon) {
  const { token, campaignUrl } = patreon;
  if (!token || !campaignUrl) {
    return null;
  }

  const user = await getPatreonUser(token);

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

async function filterData(contentfulData, pledge) {
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

const patreonBaseUrl = 'https://www.patreon.com';
const patreonAuthUrl = `${patreonBaseUrl}/oauth2/authorize`;
const patreonApiUrl = `${patreonBaseUrl}/api/oauth2`;
const patreonTokenUrl = `${patreonApiUrl}/token`;

async function refreshPatreonToken(tokenMapping) {
  // eslint-disable-next-line camelcase
  const { client_id, client_secret } = await getCreds('patreon');

  const url = patreonTokenUrl;

  console.log(`Refreshing patreon token for user ${tokenMapping.patreonUserId}`);

  const obj = {
    grant_type: 'refresh_token',
    refresh_token: tokenMapping.refreshToken,
    client_id,
    client_secret,
  };
  const body = qs.stringify(obj);
  let patreonRes;
  try {
    patreonRes = await axios.post(url, body);
    console.log('Successfully refreshed patreon token');
  } catch (err) {
    Sentry.captureException(err);
    throw new Error('Failed to refresh patreon token');
  }

  const {
    access_token: patreonToken,
    refresh_token: refreshToken,
    expires_in: expiresIn,
  } = patreonRes.data;

  const expiresAt = moment().add(expiresIn, 'seconds').toISOString();

  const patreonUser = await getPatreonUser(patreonToken);
  const patreonUserId = patreonUser.id;

  await upsertTokenMapping({
    patreonUserId,
    patreonToken,
    refreshToken,
    expiresAt,
  });
  return patreonToken;
}

/**
 * Return a route handler that maps the liturgists token (if present)
 * to the stored Patreon token, retrieves the patron's pledge (if any),
 * attaches it to the request object as req.pledge, and passes control
 * to the next function.
 *
 * Can be used in any route that supplies the `x-theliturgists-token`
 * header with the JWT that was returned from the shimmed Patreon
 * OAuth flow.
 */
function handleLiturgistsToken() {
  return wrapAsync(
    async (req, res, next) => {
      const token = _.get(
        req.headers,
        'x-theliturgists-token',
        _.get(req.query, 'token')
      );

      let tokenMappingObj;
      let tokenMapping;

      if (token) {
        const { secret } = await getCreds('jwt');
        try {
          const { userId } = jwt.verify(token, secret);
          const resp = await TokenMapping
            .query(userId)
            .exec()
            .promise();
          const [{ Items: items }] = resp;
          if (!items || items.length === 0) {
            throw new Error(`no token mapping found for userId ${userId}`);
          }
          tokenMappingObj = items[0];
          tokenMapping = tokenMappingObj.attrs;
          let { patreonToken, refreshToken, expiresAt } = tokenMapping;
          if (!patreonToken || !refreshToken) {
            throw new Error(`no patreon token found for userId ${userId}`);
          }
          const { campaign_url: campaignUrl } = await getCreds('patreon');

          // if the token is expiring soon, refresh it first
          if (moment(expiresAt).isBefore(moment().add(1, 'day'))) {
            patreonToken = await refreshPatreonToken(tokenMapping);
          }

          // Assign token mapping and pledge to request object for later use
          req.tokenMapping = items[0].attrs;
          try {
            req.pledge = await getPledge({ token: patreonToken, campaignUrl });
          } catch(err) {
            // try to refresh in case the token has expired
            const newPatreonToken = await refreshPatreonToken(tokenMapping);
            req.pledge = await getPledge({ token: newPatreonToken, campaignUrl });
          }
        } catch (err) {
          if (tokenMappingObj) {
            console.log(
              `Invalid token for patreon user ${tokenMapping.patreonUserId}; ` +
              'removing mapping'
            );
            await tokenMappingObj.destroy();
          }
          res.status(401).json({ error: 'invalid token' });
          return;
        }
      }

      next();
    },
  );
}

async function upsertTokenMapping(tokenMapping) {
  const newTokenMapping = { ...tokenMapping };
  const { patreonUserId } = newTokenMapping;

  const resp = await TokenMapping
    .query(patreonUserId)
    .usingIndex('patreonUserIdIndex')
    .exec()
    .promise();

  const [{ Items: items }] = resp;
  if (items.length > 0) {
    console.log('Patreon has existing token mapping; updating it');
    if (items.length > 1) {
      // shouldn't happen, but tidy up if it does
      console.log(`Destroying ${items.length - 1} duplicate mappings`);
      await Promise.all(items.slice(1).map(item => item.destroy()));
    }
    newTokenMapping.userId = items[0].attrs.userId;
    await TokenMapping.update(newTokenMapping)
  } else {
    console.log('Patreon has no existing token mapping; creating one');
    newTokenMapping.userId = uuidv4();

    await TokenMapping.create(newTokenMapping);
  }

  return newTokenMapping;
}

function redactUrl(url) {
  return url.replace(/token=[^&]+/, 'token=<redacted>');
}

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

  app.use(morgan((tokens, req, res) => (
    [
      tokens.method(req, res),
      redactUrl(tokens.url(req, res)),
      tokens.status(req, res),
      tokens['response-time'](req, res), 'ms'
    ].join(' ')
  )));
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
        // eslint-disable-next-line camelcase
        const { client_id, client_secret } = await getCreds('patreon');

        const url = patreonTokenUrl;

        const obj = {
          ...req.body,
          client_id,
          client_secret,
        };
        const body = qs.stringify(obj);
        let patreonRes;
        try {
          patreonRes = await axios.post(url, body);
        } catch (err) {
          res.status(err.response.status).json(err.response.data);
          return;
        }

        const {
          access_token: patreonToken,
          refresh_token: refreshToken,
          expires_in: expiresIn,
        } = patreonRes.data;

        const expiresAt = moment().add(expiresIn, 'seconds').toISOString();

        const patreonUser = await getPatreonUser(patreonToken);
        const patreonUserId = patreonUser.id;

        const { userId } = await upsertTokenMapping({
          patreonUserId,
          patreonToken,
          refreshToken,
          expiresAt,
        });

        const { secret } = await getCreds('jwt');

        // using noTimestamp here makes the token (and thus URLs containing it)
        // a bit shorter, giving us some headroom with podcast clients like
        // Overcast which have a hard limit of 256 chars on feed URL length.
        // Plus, we weren't using the issuedAt ('iat') timestamp anyway.
        const token = jwt.sign({ userId }, secret, { noTimestamp: true });
        const data = {
          liturgistsToken: token,
        };

        res.status(200).json(data);
      },
    ),
  );

  app.get(
    '*/patreon/api/*',
    handleLiturgistsToken(),
    wrapAsync(
      async (req, res) => {
        const path = req.params[1];  // second wildcard match
        const url = `${patreonApiUrl}/api/${path}`;
        const token = req.tokenMapping.patreonToken;
        const patreonRes = await axios.get(
          url,
          {
            validateStatus: null,
            headers: {
              authorization: `Bearer ${token}`,
            },
          }
        );
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
  async function contentfulGet(path, params, pledge, filter = true) {
    const contentful = await getCreds('contentful');
    const { space, environment } = contentful;

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
      return await filterData(data, pledge);
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

  app.get(
    '*/contentful/spaces/:space/environments/:env/*',
    handleLiturgistsToken(),
    wrapAsync(
      async (req, res) => {
        Sentry.addBreadcrumb({ message: 'API request', data: req.path });

        const path = req.params[1]; // second wildcard match
        const params = req.query;

        try {
          const data = await contentfulGet(path, params, req.pledge);
          res.status(200).json(data);
        } catch (e) {
          console.error(e);
          res.status(e.status).json(e.json);
        }
      },
    ),
  );

  async function canAccessFeed(collectionObj, pledge) {
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

  function getMimeType(entry) {
    // dumb assumption of MIME type from filename extension.
    // TODO: determine via HTTP HEAD Content-type response header?
    const url = getMediaUrl(entry);
    const parsed = urlParse(url);
    const extension = parsed.pathname.split('.').slice(-1)[0];
    const types = {
      mp3: 'mpeg',
    };
    const type = _.get(types, extension, extension);
    return `audio/${type}`;
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
    const query = qs.stringify(req.query);
    const querySuffix = query ? `?${query}` : '';
    return `https://${hostname}${prefix}${path}${querySuffix}`;
  }

  app.get(
    '*/rss/:collection/:collectionId',
    handleLiturgistsToken(),
    wrapAsync(
      async (req, res) => {
        const { collection, collectionId } = req.params;
        const collectionFields = {
          podcast: 'podcast',
          'meditationCategory': 'category',
        };
        if (!_.has(collectionFields, collection)) {
          throw new Error(`invalid collection '${collection}'`);
        }

        const collectionField = collectionFields[collection];
        const itemType = {
          podcast: 'podcastEpisode',
          category: 'meditation',
        }[collectionField];

        let access, collectionObj;
        if (collection === 'meditationCategory' && collectionId === 'all') {
          // there's no actual meditation category for 'all';
          // just check if the user can access meditations in general.
          access = canAccessPatronMedia(req.pledge);
        } else {
          collectionObj = await contentfulGet(
            `entries/${collectionId}`,
            {},
            req.pledge,
            false,
          );
          access = await canAccessFeed(collectionObj, req.pledge);
        }
        if (!access) {
          res.status(401).send('feed access denied');
          return;
        }

        let coverImageUrl, title, description;
        if (collectionObj) {
          ({ title, description } = collectionObj.fields);
          if (collectionObj.type === 'meditationCategory') {
            title = `The Liturgists - Meditations - ${title}`;
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
          coverImageUrl = getImageUrl(collectionObj);
        } else {
          // this is the "All Meditations" pseudo-collection
          title = 'The Liturgists - Meditations';
          description = 'All meditations in all categories.';

          const assetId = '4fw1cG2nsTZ9Upl3jpWDVH';  // ID for the cover image
          const imageAsset = await contentfulGet(`assets/${assetId}`, {});
          imageAsset.fields.file.url = `https:${imageAsset.fields.file.url}`;
          coverImageUrl = _.pick(imageAsset.fields, ['file', 'title']);
        }

        const limit = 1000;
        const collectionParams = (
          collectionObj
            ? { [`fields.${collectionField}.sys.id`]: collectionId }
            : {}
        );
        const params = {
          content_type: itemType,
          ...collectionParams,
          order: '-fields.publishedAt',
          limit,
          skip: 0,
        };
        let items = [];
        while (true) {
          const data = await contentfulGet('entries', params, req.pledge);
          items = items.concat(data.items);
          if (data.items.length < limit) {
            break;
          }
          params.skip += limit;
        }

        const category = 'Religion & Spirituality';
        const author = 'The Liturgists Network';
        const feed = new RSS({
          title: title,
          description: description,
          feed_url: getFullRequestUrl(req),
          site_url: 'https://theliturgists.com',
          image_url: coverImageUrl,
          language: 'en-US',
          categories: [category],
          pubDate: _.get(items, [0, 'fields', 'publishedAt'], null),
          custom_namespaces: {
            itunes: 'http://www.itunes.com/dtds/podcast-1.0.dtd',
            googleplay: 'http://www.google.com/schemas/play-podcasts/1.0',
          },
          custom_elements: [
            { 'itunes:block': 'yes' },
            { 'googleplay:block': 'yes' },
            { 'itunes:summary': striptags(description) },
            { 'itunes:author': author },
            {
              'itunes:owner': [
                { 'itunes:name': author },
                { 'itunes:email': 'app@theliturgists.com' },
              ],
            },
            {
              'itunes:image': {
                _attr: { href: coverImageUrl },
              },
            },
            {
              'itunes:category': {
                _attr: { text: category },
              },
            },
          ],
        });

        items.forEach((entry) => {
          feed.item({
            guid: entry.sys.id,
            title: entry.fields.title,
            description: entry.fields.description,
            date: entry.fields.publishedAt,
            enclosure: {
              url: getMediaUrl(entry),
              type: getMimeType(entry),
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
    ),
  );

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
