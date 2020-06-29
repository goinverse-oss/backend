const { Pledge } = require('./pledge');


describe('Pledge', () => {
  it('denies access when tier is null', () => {
    const podcast = {
      "sys": {
        "id": "podcast2",
      },
      "fields": {
        "patronsOnly": true
      }
    };
    const pledge = new Pledge(null, null);
    expect(pledge.isPatron()).toBe(false);
    expect(pledge.canAccessPodcast(podcast)).toBe(false);
    expect(pledge.canAccessMeditations()).toBe(false);
    expect(pledge.canAccessLiturgies()).toBe(false);
  });

  [
    ['meditations', true],
    ['meditations', false],
    ['liturgies', true],
    ['liturgies', false],
    ['adfree', true, 'adFreeListening', 'canListenAdFree'],
    ['adfree', false, 'adFreeListening', 'canListenAdFree']
  ].forEach(([resource, allow, field, predicate]) => {
    const Resource = (resource[0].toUpperCase() + resource.slice(1));
    const predicateName = predicate || `canAccess${Resource}`;
    const verb = allow ? 'allows' : 'denies';
    it(`${verb} access to ${resource} based on tier`, () => {
      const defaults = {
        canAccessMeditations: false,
        canAccessLiturgies: false,
        adFreeListening: false,
      };
      const fields = {
        ...defaults,
        [field || predicateName]: allow,
      };
      const tier = { fields };
      const pledge = new Pledge(tier, []);
      expect(pledge.isPatron()).toBe(true);
      expect(pledge[predicateName]()).toBe(allow);
    });
  });

  it('allows access to only the podcasts in the list', () => {
    const podcasts = [0, 1, 2].map(i => (
      {
        sys: {
          id: `podcast${i}`,
        },
        fields: {
          patronsOnly: true
        }
      }
    ));
    const tier = {};  // not actually used; just can't be null
    const pledge = new Pledge(tier, podcasts);
    podcasts.forEach(podcast => {
      expect(pledge.canAccessPodcast(podcast)).toBe(true);
    })

    const restrictedPodcast = {
      sys: {
        id: 'secret-podcast',
      },
      fields: {
        patronsOnly: true
      }
    };
    expect(pledge.canAccessPodcast(restrictedPodcast)).toBe(false);
  });

  it('allows access to public podcasts', () => {
    const podcast = {
      fields: {
        patronsOnly: false
      }
    };
    const tier = {};  // not actually used; just can't be null
    const pledge = new Pledge(tier, []);
    expect(pledge.canAccessPodcast(podcast)).toBe(true);
  });

  it('retrieves podcast titles', () => {
    const podcasts = [0, 1, 2].map(i => (
      {
        sys: {
          id: `podcast${i}`,
        },
        fields: {
          title: `Podcast ${i}`,
          patronsOnly: true
        }
      }
    ));
    const titles = [0, 1, 2].map(i => `Podcast ${i}`);
    const tier = {};  // not actually used; just can't be null
    const pledge = new Pledge(tier, podcasts);
    expect(pledge.getPodcastTitles()).toStrictEqual(titles);
  })
});
