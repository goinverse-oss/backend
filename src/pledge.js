const { JsonApiDataStore } = require('@theliturgists/jsonapi-datastore');
const contentful = require('contentful');
const _ = require('lodash');

const { getCreds } = require('./creds');

const CAMPAIGN_URL = 'https://www.patreon.com/theliturgists';

module.exports.fetchPledge = async function fetchPledge(patreonUserData) {
  let pledge;
  let tier;
  let podcasts;

  if (patreonUserData) {
    const data = new JsonApiDataStore();
    data.sync(patreonUserData);

    const userId = patreonUserData.data.id;
    const user = data.find('user', userId);
    const pledges = user.pledges.filter(
      p => p.reward.campaign.url === CAMPAIGN_URL,
    );
    if (pledges.length > 0) {
      pledge = pledges[0];

      const { space, environment, accessToken } = await getCreds('contentful');
      const client = contentful.createClient({
        space, environment, accessToken
      });

      // TODO: figure out why the tier isn't getting set
      const data = await client.getEntries({
        content_type: 'tier',
        'fields.patreonId': pledge.reward.id,
      })
      console.log('data:', data);
      const tiers = data.items;
      console.log('tiers:', tiers);
      if (tiers.length > 0) {
        tier = tiers[0];
        podcasts = data.includes.Entry;
      }
    }
  }

  return new Pledge(tier, podcasts);
};

class Pledge {
  /**
   * Patreon pledge data with some useful methods.
   * @param {object} patreonUserData json:api data for a Patreon user,
   *   with "pledges" relationship in the "includes"
   *   i.e. fetched from https://patreon.com/api/current_user?include=pledges
   */
  constructor(tier, podcasts) {
    this.tier = tier;
    this.podcasts = podcasts;
  }

  isPatron() {
    return !!this.tier;
  }

  canAccessPodcast(podcast) {
    // access is granted if the podcast is not patrons-only or if 
    // it is present in the tier's list of podcasts.
    if (!podcast.fields.patronsOnly) {
      return true;
    }

    if (!this.tier || !this.podcasts) {
      return false;
    }

    return !!_.find(
      this.podcasts,
      tierPodcast => podcast.sys.id === tierPodcast.sys.id
    );
  }

  canAccessMeditations() {
    if (this.tier) {
      return this.tier.fields.canAccessMeditations;
    }

    return false;
  }

  canAccessLiturgies() {
    if (this.tier) {
      return this.tier.fields.canAccessLiturgies;
    }

    return false;
  }
}

module.exports.Pledge = Pledge;
