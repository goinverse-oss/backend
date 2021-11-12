# Media Catalog Mobile App - Backend

Description forthcoming, and maybe a better name as well.

## Podbean Feed Sync

The sync lambda periodically syncs all podcasts in Contentful that
have a feed URL defined. If an episode's publication date is newer
in the feed than in Contentful, the feed data will be treated as
the correct version. However, this will only ever create or update fields;
it will never remove them.

Note that, with Podbean, the publication date of an item doesn't appear
to be updated unless the item is first saved as a draft, then published.
If an edit is made and published without this intermediate step, the
`pubDate` in the feed doesn't get updated.

## Dev setup

1. Obtain and configure AWS credentials
1. Install [assume-role](https://github.com/remind101/assume-role)
1. Configure your AWS CLI profile:

```
# $HOME/.aws/config

# ...other profiles, maybe

[media-catalog]
region = us-east-1
mfa_serial = <arn of your MFA device>

[profile media-catalog-deploy]
source_profile = media-catalog
mfa_serial = <arn of your MFA device>
role_arn = <arn of your deployer role that doesn't require MFA>
```

Now you should be able to `npm run deploy`.
