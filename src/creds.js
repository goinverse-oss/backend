const _ = require('lodash');
const awsParamStore = require('aws-param-store');

const stage = process.env.SLS_STAGE;

const credSpecs = {
  patreon: {
    client_id: `/${stage}/PATREON_CLIENT_ID`,
    client_secret: `/${stage}/PATREON_CLIENT_SECRET`,
    campaign_url: `/${stage}/PATREON_CAMPAIGN_URL`,
    creator_token: `/${stage}/PATREON_CREATOR_TOKEN`,
    campaign_id: `/${stage}/PATREON_CAMPAIGN_ID`,
  },
  contentful: {
    space: `/${stage}/CONTENTFUL_SPACE`,
    environment: `/${stage}/CONTENTFUL_ENVIRONMENT`,
    accessToken: `/${stage}/CONTENTFUL_ACCESS_TOKEN`,
    webhookVerificationToken: `/${stage}/CONTENTFUL_WEBHOOK_VERIFICATION_TOKEN`,
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
  firebase: {
    serviceAccount: `/${stage}/FIREBASE_SERVICE_ACCOUNT`,
  },
  discourse: {
    baseUrl: `/${stage}/DISCOURSE_BASE_URL`,
    token: `/${stage}/DISCOURSE_API_TOKEN`,
  },
  zoom: {
    zoomRoomPasscode: `/${stage}/ZOOM_ROOM_PASSCODE`,
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
