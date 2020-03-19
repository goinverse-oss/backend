const _ = require('lodash');
const firebase = require('firebase-admin');

const { getCreds } = require('./creds');

let firebaseInitialized = false;

async function initializeFirebase() {
  if (!firebaseInitialized) {
    const { serviceAccount } = await getCreds('firebase');
    firebase.initializeApp({
      credential: firebase.credential.cert(JSON.parse(serviceAccount)),
    });
    firebaseInitialized = true;
  }
}

const TOPIC_PUBLIC_MEDIA = 'new-public-media';
const TOPIC_PATRON_PODCAST = 'new-patron-podcast';
const TOPIC_PATRON_MEDITATION = 'new-patron-meditation';
const TOPIC_PATRON_LITURGY = 'new-patron-liturgy';

function getUnscopedTopic(entry, collectionEntry) {
  if (_.get(entry, 'fields.isFreePreview.en-US')) {
    return TOPIC_PUBLIC_MEDIA;
  }
  if (entry.sys.contentType.sys.id === 'meditation') {
    return TOPIC_PATRON_MEDITATION;
  }
  if (entry.sys.contentType.sys.id === 'liturgy') {
    return TOPIC_PATRON_LITURGY;
  }
  if (entry.sys.contentType.sys.id === 'podcastEpisode') {
    // XXX: assumes all patron podcasts have the same minimum pledge
    // (which is true at present, but perhaps not forever)
    return collectionEntry.fields.minimumPledgeDollars ? TOPIC_PATRON_PODCAST : TOPIC_PUBLIC_MEDIA;
  }
  return TOPIC_PUBLIC_MEDIA;
}

function getTopic(entry, collectionEntry) {
  const topic = getUnscopedTopic(entry, collectionEntry);
  const namespace = process.env.SLS_NAMESPACE;
  const stage = process.env.SLS_STAGE;
  let scope;
  if (namespace === stage) {
    // avoid unnecessary length of "staging-staging"
    scope = stage;
  } else {
    scope = `${namespace}-${stage}`;
  }
  return `${topic}-${scope}`;
}

function getImageUrl(collectionEntry) {
  if (collectionEntry.fields.image) {
    return `https:${collectionEntry.fields.image.fields.file.url}`
  }

  return collectionEntry.fields.imageUrl;
}

function truncate(str, limit = 1024) {
  if (str.length < limit) {
    return str;
  }

  return str.slice(0, limit - 3) + '...';
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, '');
}

function formatSubtitle(collectionEntry) {
  // collection is only missing for uncategorized meditations
  const title = _.get(collectionEntry, 'fields.title', 'Uncategorized');

  if (collectionEntry.sys.contentType.sys.id === 'meditationCategory') {
    return `Meditation: ${title}`;
  }
  return title;
}

function makeNotification(entry, collectionEntry) {
  const topic = getTopic(entry, collectionEntry);
  const title = entry.fields.title['en-US'];
  const subtitle = formatSubtitle(collectionEntry);
  const description = formatDescription(entry.fields.description['en-US']);

  return {
    topic,
    notification: {
      title,
      body: `${subtitle}\n\n${description}`,
    },
    android: {
      notification: {
        channel_id: 'main',
      },
    },
    data: {
      contentType: entry.sys.contentType.sys.id,
      entryId: entry.sys.id,
    },
  };
}

module.exports.notifyNewItem = async (entry, collectionEntry) => {
  await initializeFirebase();
  const message = makeNotification(entry, collectionEntry);
  const response = await firebase.messaging().send(message);
  console.log(`Successfully sent message to topic "${message.topic}": `, response);
  return { message, response };
};
