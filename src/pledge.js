import { JsonApiDataStore } from '@theliturgists/jsonapi-datastore';

const CAMPAIGN_URL = 'https://www.patreon.com/theliturgists';

const OLD_TIER_REWARD_IDS = {
  NON_MEMBER: '-1',
  MEMBER: '1',
};

const NEW_TIER_REWARD_IDS = {
  BE_A_LITURGIST: '3956585',
  GROW_WITH_US: '3956587',
  TALK_WITH_US: '3956589',
  ON_THE_GUEST_LIST: '3956592',
};

export default class Pledge {
  /**
   * Patreon pledge data with some useful methods.
   * @param {object} patreonUserData json:api data for a Patreon user,
   *   with "pledges" relationship in the "includes"
   *   i.e. fetched from https://patreon.com/api/current_user?include=pledges
   */
  constructor(patreonUserData) {
    this.pledge = null;

    if (patreonUserData) {
      const data = new JsonApiDataStore();
      data.sync(patreonUserData);

      const userId = patreonUserData.data.id;
      const user = data.find('user', userId);
      const pledges = user.pledges.filter(
        p => p.reward.campaign.url === CAMPAIGN_URL,
      );
      if (pledges.length > 0) {
        this.pledge = pledges[0];
      }
    }
  }

  _isOldTierPledge() {
    return this.pledge?.reward?.id === OLD_TIER_REWARD_IDS.MEMBER;
  }

  _isNewTierPledge() {
    const rewardId = this.pledge?.reward?.id;
    return rewardId && Object.values(NEW_TIER_REWARD_IDS).find(
      newTierId => newTierId === rewardId,
    );
  }

  isPatron() {
    if (!this.pledge) {
      return false;
    }
    return this.pledge?.reward?.id !== OLD_TIER_REWARD_IDS.NON_MEMBER;
  }

  canAccessPatronPodcasts() {
    if (this._isOldTierPledge()) {
      const minOldPatronPodcastsPledge = 100;
      return this.pledge.amount_cents >= minOldPatronPodcastsPledge;
    }

    if (this._isNewTierPledge()) {
      const minNewPatronPodcastsPledge = 300;
      return this.pledge.amount_cents >= minNewPatronPodcastsPledge;
    }

    return false;
  }

  canAccessMeditations() {
    if (this._isOldTierPledge()) {
      // const minOldMeditationsPledge = 500;
      const minOldMeditationsPledge = 100;
      return this.pledge.amount_cents >= minOldMeditationsPledge;
    }

    if (this._isNewTierPledge()) {
      // const minNewMeditationsPledge = 1000;
      const minNewMeditationsPledge = 300;
      return this.pledge.amount_cents >= minNewMeditationsPledge;
    }

    return false;
  }
}
