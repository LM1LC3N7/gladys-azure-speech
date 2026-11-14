# Third-party notices

## Gladys integration SDK

`@gladysassistant/integration-sdk` (Apache-2.0) is installed from npm and
shipped in the Docker image under `node_modules/` with its own license file.

## Microsoft Azure Speech

"Microsoft" and "Azure" are trademarks of the Microsoft group of companies,
used only to name the service this integration talks to. No Microsoft code
is used: the integration calls the public Azure Speech REST API
(`learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech`)
with Node's built-in `fetch`. The voice and region lists of `src/constants.js`
follow the public Azure Speech documentation.
