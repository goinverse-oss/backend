const serverless = require('serverless-http');
const bodyParser = require('body-parser');
const express = require('express');
const qs = require('qs');
const awsParamStore = require('aws-param-store');
const axios = require('axios');
const helmet = require('helmet');
const _ = require('lodash');
const { patreon: patreonAPI } = require('patreon');

const stage = process.env.SLS_STAGE;

async function getCreds() {
  const opts = { region: process.env.AWS_REGION };
  const names = {
    patreon: {
      client_id: `/${stage}/PATREON_CLIENT_ID`,
      client_secret: `/${stage}/PATREON_CLIENT_SECRET`,
    },
    contentful: {
      space: `/${stage}/CONTENTFUL_SPACE`,
      environment: `/${stage}/CONTENTFUL_ENVIRONMENT`,
      accessToken: `/${stage}/CONTENTFUL_ACCESS_TOKEN`,
    },
  };

  // Fetch all values asynchronously
  const paths = _.flatMap(
    _.keys(names),
    ns => _.keys(names[ns]).map(credName => `${ns}.${credName}`),
  );
  const params = await Promise.all(
    paths.map(path => awsParamStore.getParameter(
      _.get(names, path),
      opts,
    )),
  );
  _.each(paths, (path, i) => _.set(names, path, params[i].Value));
  return names;
}

const CAMPAIGN_URL = 'https://www.patreon.com/bdhtest';

async function filterData(contentType, contentfulData, patreonToken) {
  let user = null;
  let pledge = null;

  if (patreonToken) {
    const client = patreonAPI(patreonToken);
    const { store, rawJson } = await client('/current_user?includes=pledges');
    user = store.find('user', rawJson.data.id);

    pledge = _.find(user.pledges, p => (p.reward.campaign.url === CAMPAIGN_URL));
  }

  let canAccess;
  if (contentType === 'podcastEpisode') {
    // podcasts are included; pull them out by ID first
    const podcasts = _.fromPairs(
      contentfulData.includes.Entry.filter(
        entry => entry.sys.contentType.sys.id === 'podcast',
      ).map(podcast => ([podcast.sys.id, podcast])),
    );

    canAccess = (episode) => {
      const podcast = podcasts[episode.fields.podcast.sys.id];
      return (
        _.get(podcast.fields, 'minimumPledgeDollars', null) === null
          || (
            !!pledge
              && podcast.fields.minimumPledgeDollars * 100 <= pledge.amount_cents
          )
      );
    };
  } else if (contentType === 'meditation') {
    const hasMeditations = (
      pledge && /Meditations/i.test(pledge.reward.title)
    );
    canAccess = () => hasMeditations;
  } else {
    return contentfulData;
  }

  return {
    ...contentfulData,
    items: contentfulData.items.map(
      (item) => {
        if (canAccess(item)) {
          return item;
        }

        const filteredItem = item.fields.isFreePreview
          ? item
          : _.omit(item, 'fields.mediaUrl');

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

async function init() {
  const app = express();

  const { patreon, contentful } = await getCreds();

  app.use(helmet());

  app.post(
    '*/patreon/validate',
    bodyParser.urlencoded({ extended: true }),
    async (req, res) => {
      const url = 'https://www.patreon.com/api/oauth2/token';

      const obj = {
        ...req.body,
        ...patreon,
      };
      const body = qs.stringify(obj);
      const patreonRes = await axios.post(url, body, { validateStatus: null });
      res.status(patreonRes.status).json(patreonRes.data);
    },
  );

  app.get('*/contentful/*', async (req, res) => {
    const path = req.path
      .replace(new RegExp(`^(/${stage})?/contentful`), '')
      .replace(/\/spaces\/[^/]+/, `/spaces/${contentful.space}`)
      .replace(/\/environments\/[^/]+/, `/environments/${contentful.environment}`);
    const host = 'https://cdn.contentful.com';
    const url = `${host}/${path}`;
    const contentfulRes = await axios.get(url, {
      params: req.query,
      validateStatus: null,
      headers: {
        authorization: `Bearer ${contentful.accessToken}`,
      },
    });
    const patreonToken = _.get(req.headers, 'x-theliturgists-patreon-token');
    const { status } = contentfulRes;
    let { data } = contentfulRes;
    if (status >= 200 && status < 300) {
      data = await filterData(req.query.content_type, data, patreonToken);
    }
    res.status(status).json(data);
  });

  return app;
}

let handler;

module.exports.init = init;
module.exports.handler = async (event, context) => {
  if (!handler) {
    const app = await init();
    handler = serverless(app);
  }

  return handler(event, context);
};
