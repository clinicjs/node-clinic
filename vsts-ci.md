# Azure Pipelines

Below is the information on `Azure Pipelines` configuration

## General

We create multiple build pipelines with Node.JS version per pipeline specified in `pipeline variables`.
Configuration is stored in the file `.vsts-ci.yml` in the project root directory.

## Supported pipline variables

`node_version`: `string` `(required)`
example
`node_version: 9.x`

`skip_darwin`: `True`|`False` `(optional)`

`skip_linux`: `True`|`False` `(optional)`

`skip_windows`: `True`|`False` `(optional)`

## Setup

Azure Pipelines runs `ci-lint` and `ci-test` scripts on `PR` and merges into the `master` branch.
