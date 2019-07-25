const _ = require('lodash');
const firebase = require('firebase-admin');

firebase.initializeApp({
  credential: firebase.credential.applicationDefault(),
});

const TOPIC_PUBLIC_MEDIA = 'new-public-media';
const TOPIC_PATRON_PODCAST = 'new-patron-podcast';
const TOPIC_PATRON_MEDITATION = 'new-patron-meditation';
const TOPIC_PATRON_LITURGY = 'new-patron-liturgy';

function getCollection(entry) {
  
}

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

function notifyNewItem(entry, collectionEntry) {
  const message = makeNotification(entry, collectionEntry);
  return firebase.messaging().send(message)
    .then(response => console.log('Successfully sent message: ', response))
    .catch(error => console.error('Error sending message: ', error));
}


if (require.main === module) {
  const entry = require('./notify-data/podcastEpisode.json');
  const collectionEntry = require('./notify-data/podcast.json');
  notifyNewItem(entry, collectionEntry).then(() => process.exit(0));
}
