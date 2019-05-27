const _ = require('lodash');
const awsParamStore = require('aws-param-store');

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
  contentfulManagement: {
    accessToken: `/${stage}/CONTENTFUL_MANAGEMENT_ACCESS_TOKEN`,
  },
  sentry: {
    dsn: `/${stage}/SENTRY_DSN`,
  },
  jwt: {
    secret: `/${stage}/JWT_SECRET`,
  },
};

module.exports.getCreds = async (name) => {
  const credSpec = credSpecs[name];
  const opts = { region: process.env.AWS_REGION };
  const keys = _.keys(credSpec);
  const params = await Promise.all(
    keys.map(key => awsParamStore.getParameter(credSpec[key], opts)),
  );
  const values = _.map(params, 'Value');
  return _.zipObject(keys, values);
};
