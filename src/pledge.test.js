const { Pledge } = require('./pledge');

const patreonUserData = {
  "data": {
    "attributes": {},
    "id": "user-1",
    "relationships": {
      "pledges": {
        "data": [
          {
            "id": "pledge-1",
            "type": "pledge"
          }
        ]
      }
    },
    "type": "user"
  },
  "included": [
    {
      "attributes": {
        "amount_cents": 2500,
      },
      "id": "pledge-1",
      "relationships": {
        "reward": {
          "data": {
            "id": "reward-1",
            "type": "reward"
          }
        }
      },
      "type": "pledge"
    },
    {
      "attributes": {
        "amount": 2500,
        "amount_cents": 2500,
        "published": true,
        "published_at": "2020-05-20T21:43:11.382+00:00",
        "title": "Tier Name",
        "unpublished_at": null
      },
      "id": "reward-1",
      "type": "reward"
    },
  ]
};

const tier = {
  "fields": {
    "title": "Tier Tame",
    "description": "Tier Description",
    "amountCents": 2500,
    "isUnpublished": false,
    "isDeleted": false,
    "patreonId": "349058",
    "canAccessMeditations": true,
    "canAccessLiturgies": true,
    "adFreeListening": true,
    "podcasts": [
      {
        "sys": {
          "type": "Link",
          "linkType": "Entry",
          "id": "podcast1"
        }
      },
      {
        "sys": {
          "type": "Link",
          "linkType": "Entry",
          "id": "podcast2"
        }
      },
      {
        "sys": {
          "type": "Link",
          "linkType": "Entry",
          "id": "podcast3"
        }
      }
    ],
    "patronsOnly": false
  }
};

const podcast = {
  "sys": {
    "id": "podcast2",
    "type": "Entry",
    "createdAt": "2019-02-26T17:48:04.562Z",
    "updatedAt": "2020-06-16T03:26:31.230Z"
  },
  "fields": {
    "title": "Super special patron podcast",
    "description": "Text text text",
    "patronsOnly": true
  }
};

describe('Pledge', () => {
  it('denies access when tier is null', () => {
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
  ].forEach(([resource, allow]) => {
    const Resource = resource[0].toUpperCase() + resource.slice(1);
    const predicateName = `canAccess${Resource}`;
    const verb = allow ? 'allows' : 'denies';
    it(`${verb} access to ${resource} based on tier`, () => {
      const defaults = {
        canAccessMeditations: false,
        canAccessLiturgies: false,
      };
      const fields = {
        ...defaults,
        [predicateName]: allow,
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
});
