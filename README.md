# The Liturgsts App - Backend

Description forthcoming.

## Dev setup

1. Obtain and configure AWS credentials
1. Install [assume-role](https://github.com/remind101/assume-role)
1. Configure your AWS CLI profile:

```
# $HOME/.aws/config

# ...other profiles, maybe

[theliturgists]
region = us-east-1
mfa_serial = <arn of your MFA device>

[profile theliturgists-deploy]
source_profile = theliturgists
mfa_serial = <arn of your MFA device>
role_arn = <arn of your deployer role that doesn't require MFA>
```

Now you should be able to `npm run deploy`.
