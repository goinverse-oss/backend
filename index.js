const serverless = require('serverless-http');
const bodyParser = require('body-parser');
const express = require('express');
const qs = require('qs');
const awsParamStore = require('aws-param-store');
const axios = require('axios');

async function getPatreonClientCreds() {
  const opts = { region: process.env.AWS_REGION };
  const stage = process.env.SLS_STAGE;
  const names = [
    `/${stage}/PATREON_CLIENT_ID`,
    `/${stage}/PATREON_CLIENT_SECRET`,
  ];
  const result = await awsParamStore.getParameters(names, opts);
  const params = result.Parameters;

  // eslint-disable-next-line camelcase
  const [client_id, client_secret] = params.map(param => param.Value);
  return { client_id, client_secret };
}

async function init() {
  const app = express();

  const creds = await getPatreonClientCreds();

  app.use(bodyParser.urlencoded());
  app.post('*/patreon/validate', async (req, res) => {
    const url = 'https://www.patreon.com/api/oauth2/token';

    const obj = {
      ...req.body,
      ...creds,
    };
    const body = qs.stringify(obj);
    const patreonRes = await axios.post(url, body, { validateStatus: null });
    res.status(patreonRes.status).json(patreonRes.data);
  });

  return app;
}

let handler;

module.exports.handler = async (event, context) => {
  if (!handler) {
    const app = await init();
    handler = serverless(app);
  }

  return handler(event, context);
};
