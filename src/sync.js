const _ = require('lodash');
const { createClient } = require('contentful-management');
const Parser = require('rss-parser');
const yargs = require('yargs');
const ProgressBar = require('progress');
const Sentry = require('@sentry/node');
const moment = require('moment');
const axios = require('axios');
const qs = require('qs');

const { getCreds } = require('./creds');

// https://github.com/axios/axios/issues/1111#issuecomment-634632309
axios.defaults.paramsSerializer = function(params) {
  return qs.stringify(params, { indices: false }); // param=value1&param=value2
};

/* eslint-disable no-restricted-syntax */
/* eslint-disable no-await-in-loop */

async function getPodcasts(environment) {
  const response = await environment.getEntries({
    content_type: 'podcast',
  });

  // just the ones with a public feed
  return response.items.filter(p => _.get(p.fields, 'feedUrl'));
}

async function getSeasons(environment, podcast) {
  const response = await environment.getEntries({
    content_type: 'podcastSeason',
    'fields.podcast.sys.id': podcast.sys.id,
  });
  return _.keyBy(response.items, 'fields.number.en-US');
}

async function getEpisodes(environment, podcast) {
  const response = await environment.getEntries({
    content_type: 'podcastEpisode',
    limit: 1000,
    'fields.podcast.sys.id': podcast.sys.id,
  });
  return response.items;
}

async function parseFeed(feedUrl) {
  const parser = new Parser({ timeout: 30000 });
  return parser.parseURL(feedUrl);
}

const makeLink = entry => ({
  sys: {
    type: 'Link',
    linkType: 'Entry',
    id: entry.sys.id,
  },
});

const withLocale = (value) => {
  return { 'en-US': value };
};


async function createSeason(environment, podcast, number) {
  const seasonJson = {
    fields: {
      number: withLocale(parseInt(number, 10)),
      title: withLocale(`Season ${number}`),
      podcast: withLocale(makeLink(podcast)),
    },
  };
  const season = await environment.createEntry('podcastSeason', seasonJson);
  await season.publish();
  return season;
}

function fixDuration(duration) {
  // Pad the string with '0:' if it is missing hours or minutes
  const nums = duration.split(':');
  const paddedNums = Array(3 - nums.length).fill('0').concat(nums);
  return paddedNums.join(':');
}

class ContentfulCache {
  constructor(environment) {
    this.environment = environment;
    this.cache = {};
    this.pks = {
      contributor: 'name',
      tag: 'name',
    };
  }

  _getPk(contentType) {
    return _.get(this.pks, contentType, 'title');
  }

  async _initContentType(contentType) {
    const pk = this._getPk(contentType);
    const data = await this.environment.getEntries({
      content_type: contentType,
    });
    this.cache[contentType] = _.keyBy(data.items, `fields.${pk}.en-US`);
  }

  async getOrCreate(contentType, pkValue) {
    if (!_.has(this.cache, contentType)) {
      await this._initContentType(contentType);
    }

    if (_.has(this.cache, [contentType, pkValue])) {
      return this.cache[contentType][pkValue];
    }

    const pk = this._getPk(contentType);

    const entry = await this.environment.createEntry(
      contentType,
      {
        fields: {
          [pk]: withLocale(pkValue),
        },
      },
    );
    this.cache[contentType][pkValue] = entry;
    await entry.publish();
    return entry;
  }
}

function logProgress(progress, msg) {
  if (progress.stream.clearLine) {
    progress.interrupt(msg);
  } else {
    console.log(msg);
  }
}

async function syncEpisode(
  progress, environment, cache, podcast, seasons, episodesById, rssItem,
) {
  let existingEpisode = _.get(episodesById, rssItem.guid);

  const { title } = rssItem;
  const description = (
    rssItem.description
    || _.get(rssItem, 'content.encoded')
    || rssItem.content
  );
  const episodeJson = {
    fields: {
      podbeanEpisodeId: withLocale(rssItem.guid),
      title: withLocale(title),
      description: withLocale(description),
      publishedAt: withLocale(rssItem.isoDate),
      podcast: withLocale(makeLink(podcast)),
    },
  };

  // Grab contributors and tags from description,
  // create them in Contentful if necessary, and
  // set them on the episode.
  const lines = description.match(/[^\r\n]+/g);
  for (const line of lines) {
    // look for "contributors:" or "tags:" followed by a
    // comma-separated list of names.
    const match = line.match(
      /(contributors|tags):([^,]+(?:,[^,]+)*);/,
    );
    if (match) {
      const [label, valuesCsv] = match.slice(1);
      const contentType = label.replace(/s$/, '');
      const values = valuesCsv.split(',');
      const links = [];
      for (const value of values) {
        const entry = await cache.getOrCreate(contentType, value);
        links.push(makeLink(entry));
      }
      episodeJson.fields[label] = withLocale(links);
    }
  }

  function setIfPresent(key, path) {
    const value = _.get(rssItem, path);
    if (value) {
      episodeJson.fields[key] = withLocale(value);
    }
  }

  [
    ['imageUrl', 'itunes.image'],
    ['mediaUrl', 'enclosure.url'],
    ['duration', 'itunes.duration'],
  ].forEach(args => setIfPresent(...args));

  episodeJson.fields.duration['en-US'] = fixDuration(
    episodeJson.fields.duration['en-US'],
  );

  const seasonEpisodeNumber = _.get(rssItem, 'itunes.episode');
  if (seasonEpisodeNumber) {
    episodeJson.fields.seasonEpisodeNumber = withLocale(
      parseInt(seasonEpisodeNumber, 10),
    );
  }

  const seasonNumber = _.get(rssItem, 'itunes.season');
  if (seasonNumber && seasons[seasonNumber]) {
    episodeJson.fields.season = withLocale(makeLink(seasons[seasonNumber]));
  }

  if (!existingEpisode) {
    logProgress(progress, `Creating episode: "${title}"`);
    const episode = await environment.createEntry(
      'podcastEpisode', episodeJson,
    );
    await episode.publish();
    return { episode, status: 'created' };
  }

  let status = 'unchanged';

  // only update fields that are explicitly set in the RSS item
  const newFields = {
    ...existingEpisode.fields,
    ...episodeJson.fields,
  };

  if (!_.isEqual(existingEpisode.fields, newFields)) {
    const publishedAt = moment(existingEpisode.fields.publishedAt['en-US']);
    const oneWeekInMillis = 1000 * 60 * 60 * 24 * 7;
    if (moment().diff(publishedAt) > oneWeekInMillis) {
      logProgress(progress, `Not updating episode: "${title}" (older than one week)`);
    } else {
      logProgress(progress, `Updating episode: "${title}"`);
      status = 'updated';
      existingEpisode.fields = newFields;
      existingEpisode = await existingEpisode.update();
      await existingEpisode.publish();
    }
  }

  return { episode: existingEpisode, status };
}

function getSeasonNumbersFromFeed(feed) {
  return new Set(
    _(feed.items)
      .map('itunes.season')
      .filter(s => !_.isUndefined(s))
      .value(),
  );
}

async function syncPodcast(environment, cache, podcast) {
  const feedUrl = podcast.fields.feedUrl['en-US'];

  console.log(`Parsing feed from ${feedUrl}`);
  const feed = await parseFeed(feedUrl);

  const seasonNumbers = getSeasonNumbersFromFeed(feed);
  const seasons = await getSeasons(environment, podcast);
  const newSeasonNumbers = Array.from(seasonNumbers)
    .filter(sn => !_.has(seasons, sn));

  if (newSeasonNumbers.length > 0) {
    const bar = new ProgressBar(
      'Creating seasons: :current/:total :bar',
      { total: newSeasonNumbers.length },
    );
    for (const seasonNumber of newSeasonNumbers) {
      seasons[seasonNumber] = await createSeason(
        environment, podcast, seasonNumber,
      );
      bar.tick();
    }
    console.log(`Created ${newSeasonNumbers.length} seasons`);
  }

  const episodes = await getEpisodes(environment, podcast);
  const episodesById = _.keyBy(episodes, 'fields.podbeanEpisodeId.en-US');
  const counts = {
    updated: 0,
    created: 0,
    unchanged: 0,
  };
  const bar = new ProgressBar(
    'Syncing episodes: [:bar] :current/:total (:created created, :updated updated)',
    {
      total: feed.items.length,
      incomplete: ' ',
      width: 20,
      ...counts,
    },
  );
  for (const item of feed.items) {
    const { status } = await syncEpisode(
      bar, environment, cache, podcast, seasons, episodesById, item,
    );

    counts[status] += 1;
    bar.tick(counts);
  }
}

async function syncPodcasts(accessToken, spaceId, environmentId) {
  const contentful = createClient({ accessToken });
  const space = await contentful.getSpace(spaceId);
  const environment = await space.getEnvironment(environmentId);

  const cache = new ContentfulCache(environment);

  console.log('Getting public podcasts...');
  const podcasts = await getPodcasts(environment);
  console.log(`Syncing ${podcasts.length} public podcasts...`);
  for (const podcast of podcasts) {
    await syncPodcast(environment, cache, podcast);
  }
}

async function syncTier(environment, existingTiersById, tier) {
  let contentfulTier;
  let tierFields = {
    patreonId: withLocale(tier.id),
    title: withLocale(tier.attributes.title),
    description: withLocale(tier.attributes.description),
    amountCents: withLocale(tier.attributes.amount_cents),
    isUnpublished: withLocale(tier.attributes.unpublished_at !== null),
    isDeleted: withLocale(false),
  };
  if (_.has(existingTiersById, tier.id)) {
    contentfulTier = existingTiersById[tier.id];
    if (!_.isMatch(contentfulTier.fields, tierFields)) {
      contentfulTier.fields = {
        ...contentfulTier.fields,
        ...tierFields,
      };
      contentfulTier = await contentfulTier.update();
    }
  } else {
    contentfulTier = await environment.createEntry('tier', { fields: tierFields });
  }
  await contentfulTier.publish();
  return contentfulTier;
}

async function markTierDeleted(environment, deletedTier) {
  deletedTier.fields.isDeleted = withLocale(true);
  const updatedTier = await deletedTier.update();
  await updatedTier.publish();
}

async function syncTiers(
  accessToken,
  spaceId,
  environmentId,
  patreonCreatorToken,
  patreonCampaignId,
) {
  const contentful = createClient({ accessToken });
  const space = await contentful.getSpace(spaceId);
  const environment = await space.getEnvironment(environmentId);

  const campaignUrl = `https://www.patreon.com/api/oauth2/v2/campaigns/${patreonCampaignId}`;
  const opts = {
    headers: {
      authorization: `Bearer ${patreonCreatorToken}`,
    },
    params: {
      'fields[campaign]': 'summary',
      'include': 'tiers',
      'fields[tier]': 'title,description,amount_cents,unpublished_at'
    },
  };
  try {
    console.log(`Fetching ${campaignUrl}`);
    const res = await axios.get(campaignUrl, opts);
    console.log('tiers:', JSON.stringify(res.data, null, 2));
    const tiers = res.data.included;

    const response = await environment.getEntries({
      content_type: 'tier',
      limit: 1000,
    });
    const existingTiers = response.items;
    console.log('existingTiers:', JSON.stringify(existingTiers, null, 2));
    const existingTiersById = _.keyBy(existingTiers, 'fields.patreonId.en-US');

    console.log(`Syncing ${tiers.length} tiers from Patreon`);
    for (const tier of tiers) {
      console.log(`- ${tier.attributes.title}`);
      await syncTier(environment, existingTiersById, tier);
    }

    const tiersById = _.keyBy(tiers, 'id');
    const deletedTiers = existingTiers.filter(
      existingTier => !_.has(tiersById, existingTier.fields.patreonId['en-US'])
    );
    if (deletedTiers.length > 0) {
      console.log(`Marking ${deletedTiers.length} tiers deleted`);
      for (const deletedTier of deletedTiers) {
        console.log(`- ${deletedTier.fields.title['en-US']}`);
        await markTierDeleted(environment, deletedTier);
      }
    }
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

async function main() {
  const { argv } = yargs
    .options({
      accessToken: {
        describe: 'Contentful access token',
        demandOption: true,
      },
      spaceId: {
        describe: 'Contentful space ID',
        demandOption: true,
      },
      environmentId: {
        describe: 'Contentful environment ID',
        demandOption: true,
      },
      patreonCreatorToken: {
        describe: 'Patreon creator token (APIv2)',
      },
      patreonCampaignId: {
        describe: 'Patreon campaign ID',
      },
      include: {
        describe: 'What things to sync',
        choices: ['tiers', 'podcasts', 'all'],
        default: 'all',
      }
    });

  const {
    accessToken,
    spaceId,
    environmentId,
    patreonCreatorToken,
    patreonCampaignId,
    include,
  } = argv;

  try {
    if (include === 'podcasts' || include === 'all') {
      await syncPodcasts(accessToken, spaceId, environmentId);
    }
    if (include === 'tiers' || include === 'all') {
      if (!patreonCreatorToken) {
        throw new Error('Need --patreonCreatorToken when syncing tiers');
      }
      if (!patreonCampaignId) {
        throw new Error('Need --patreonCampaignId when syncing tiers');
      }
      await syncTiers(
        accessToken,
        spaceId,
        environmentId,
        patreonCreatorToken,
        patreonCampaignId,
      );
    }
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
  console.log('Done.');
}

if (require.main === module) {
  main();
}

module.exports.handler = async () => {
  const sentry = await getCreds('sentry');
  Sentry.init(sentry);
  Sentry.configureScope((scope) => {
    scope.setTag('stage', process.env.SLS_STAGE);
  });

  const contentful = await getCreds('contentful');
  const contentfulManagement = await getCreds('contentfulManagement');
  const patreon = await getCreds('patreon');
  try {
    await syncTiers(
      contentfulManagement.accessToken,
      contentful.space,
      contentful.environment,
      patreon.creator_token,
      patreon.campaign_id,
    );
    await syncPodcasts(
      contentfulManagement.accessToken,
      contentful.space,
      contentful.environment,
    );
    console.log('Done.');
  } catch (err) {
    console.error(err);
    Sentry.captureException(err);
    throw err;
  }
};
