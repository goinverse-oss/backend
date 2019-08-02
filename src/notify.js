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

function getTopic(entry, collectionEntry) {
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

function getImageUrl(collectionEntry) {
  if (collectionEntry.fields.image) {
    return `https:${collectionEntry.fields.image.fields.file.url}`
  }

  return collectionEntry.fields.imageUrl;
}

function makeNotification(entry, collectionEntry) {
  const topic = getTopic(entry, collectionEntry);
  const title = entry.fields.title['en-US'];
  const subtitle = collectionEntry.fields.title;

  return {
    topic,
    notification: {
      title: `${title} (${subtitle})`,
      body: entry.fields.description['en-US'],
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
  return response;
};