const { CognitoIdentityServiceProvider: Cognito } = require('aws-sdk')
const prompt = require('prompt')
const tokenUtil = require('./token-util')

module.exports = login

const questionFor = {
  password: {
    description: 'Password',
    hidden: true,
    name: 'password',
    required: true,
    type: 'string'
  },
  username: {
    description: 'Username',
    name: 'username',
    required: true,
    type: 'string'
  }
}

function login (username, cb) {
  const questions = username ? [ questionFor.password ]
    : [ questionFor.username, questionFor.password ]

  prompt.delimiter = ''
  prompt.message = ''
  prompt.start()

  prompt.get(questions, function (err, answerFor) {
    if (err) return cb(err)

    const request = {
      AuthFlow: 'ADMIN_NO_SRP_AUTH',
      AuthParameters: {
        PASSWORD: answerFor.password,
        USERNAME: answerFor.username || username
      },
      ClientId: tokenUtil.clientId,
      UserPoolId: 'us-east-2_HUMWUJxKU'
    }

    const serviceProvider = new Cognito({ region: 'us-east-2' })

    serviceProvider.adminInitiateAuth(request, function (err, body) {
      if (err) return cb(err)
      const { AuthenticationResult: authenticationResult } = body
      const { AccessToken: accessToken, RefreshToken: refreshToken } = authenticationResult
      tokenUtil.saveTokens({ accessToken, refreshToken }, cb)
    })
  })
}
