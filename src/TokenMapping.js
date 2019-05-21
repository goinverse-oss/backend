const dynamodb = require('dynamodb');
const Joi = require('@hapi/joi');

const TokenMapping = dynamodb.define(
  'TokenMapping',
  {
    hashKey: 'userId',
    timestamps: true,
    schema: {
      userId: Joi.string(),
      patreonUserId: Joi.string(),
      patreonToken: Joi.string(),
      refreshToken: Joi.string(),
      expiresAt: Joi.string(),
    },
    indexes: [
      {
        hashKey: 'patreonUserId',
        type: 'global',
        name: 'patreonUserIdIndex',
      },
    ],
  },
);

TokenMapping.config({
  tableName: process.env.DYNAMODB_TABLE_TOKENS,
});

module.exports = TokenMapping;
