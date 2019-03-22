const _ = require('lodash');
const { createClient } = require('contentful-management');
const Parser = require('rss-parser');
const yargs = require('yargs');
const ProgressBar = require('progress');

/* eslint-disable no-restricted-syntax */
/* eslint-disable no-await-in-loop */

/*
 * TODO:
 * 1) Fetch all podcasts from Contentful that have a feed URL
 * 2) Fetch all seasons and episodes from Contentful
 * 3) Fetch RSS feeds from Podbean
 * 4) Create any seasons that don't already exist in Contentful
 * 5) Create any episodes that don't already exist in Contentful
 */

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
  const parser = new Parser({ timeout: 5000 });
  return parser.parseURL(feedUrl);
}

const makeLink = entry => ({
  sys: {
    type: 'Link',
    linkType: 'Entry',
    id: entry.sys.id,
  },
});

const withType = (value, type = null) => {
  const data = type === null ? value : {
    type,
    value,
  };
  return { 'en-US': data };
};


async function createSeason(environment, podcast, number) {
  const seasonJson = {
    fields: {
      number: withType(parseInt(number, 10)),
      title: withType(`Season ${number}`),
      podcast: withType(makeLink(podcast)),
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

async function syncEpisode(
  environment, podcast, seasons, episodesById, rssItem,
) {
  const existingEpisode = _.get(episodesById, rssItem.guid);

  const episodeJson = {
    fields: {
      podbeanEpisodeId: withType(rssItem.guid),
      title: withType(rssItem.title),
      description: withType((
        rssItem.description
        || _.get(rssItem, 'content.encoded')
        || rssItem.content
      )),
      publishedAt: withType(rssItem.isoDate),
      podcast: withType(makeLink(podcast)),
    },
  };

  function setIfPresent(key, path) {
    const value = _.get(rssItem, path);
    if (value) {
      episodeJson.fields[key] = withType(value);
    }
  }

  [
    ['imageUrl', 'itunes.image.href'],
    ['mediaUrl', 'enclosure.url'],
    ['duration', 'itunes.duration'],
  ].forEach(args => setIfPresent(...args));

  episodeJson.fields.duration['en-US'] = fixDuration(
    episodeJson.fields.duration['en-US'],
  );

  const seasonEpisodeNumber = _.get(rssItem, 'itunes.episode');
  if (seasonEpisodeNumber) {
    episodeJson.fields.seasonEpisodeNumber = withType(
      parseInt(seasonEpisodeNumber, 10),
    );
  }

  const seasonNumber = _.get(rssItem, 'itunes.season');
  if (seasonNumber && seasons[seasonNumber]) {
    episodeJson.fields.season = withType(makeLink(seasons[seasonNumber]));
  }

  if (!existingEpisode) {
    const episode = await environment.createEntry(
      'podcastEpisode', episodeJson,
    );
    await episode.publish();
    return episode;
  }

  if (!_.isEqual(existingEpisode.fields, episodeJson.fields)) {
    existingEpisode.fields = episodeJson.fields;
    await existingEpisode.update();
    await existingEpisode.publish();
  }

  return existingEpisode;
}

function getSeasonNumbersFromFeed(feed) {
  return new Set(
    _(feed.items)
      .map('itunes.season')
      .filter(s => !_.isUndefined(s))
      .value(),
  );
}

async function syncPodcast(environment, podcast) {
  const feedUrl = `${podcast.fields.feedUrl['en-US']}`;
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
  }

  const episodes = await getEpisodes(environment, podcast);
  const episodesById = _.keyBy(episodes, 'fields.podbeanEpisodeId.en-US');
  const bar = new ProgressBar(
    'Syncing episodes: :current/:total :bar',
    { total: feed.items.length },
  );
  for (const item of feed.items) {
    await syncEpisode(
      environment, podcast, seasons, episodesById, item,
    );
    bar.tick();
  }
}

async function syncPodcasts(accessToken, spaceId, environmentId) {
  const contentful = createClient({ accessToken });
  const space = await contentful.getSpace(spaceId);
  const environment = await space.getEnvironment(environmentId);

  console.log('Getting public podcasts...');
  const podcasts = await getPodcasts(environment);
  console.log(`Syncing ${podcasts.length} public podcasts...`);
  for (const podcast of podcasts) {
    await syncPodcast(environment, podcast);
  }
}

if (require.main === module) {
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
    });

  const { accessToken, spaceId, environmentId } = argv;

  syncPodcasts(accessToken, spaceId, environmentId)
    .then(() => console.log('Done.'))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
