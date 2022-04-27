import {
  IParsedOAuth2TokenResult,
  TwitterApi,
  TwitterApiReadOnly,
} from 'twitter-api-v2';
import fastify from 'fastify';
import fastifyStatic from 'fastify-static';
import fastifyCookie from '@fastify/cookie';
import FastifySessionPlugin from '@fastify/session';
import fastifyRedis from '@fastify/redis';
import path from 'path';
import readenv from '@cm-ayf/readenv';

type Token = Pick<
  IParsedOAuth2TokenResult,
  'accessToken' | 'refreshToken' | 'expiresIn'
> & {
  expiresAt: number;
};

if (process.env.NODE_ENV !== 'production')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('dotenv').config();

const {
  BEARER_TOKEN,
  USER_ID,
  HOST,
  REDIRECT_HOST,
  PORT,
  REDIS_URL,
  SECRET,
  PRODUCTION,
  ...CLIENT
} = readenv({
  clientId: {
    from: 'CLIENT_ID',
  },
  clientSecret: {
    from: 'CLIENT_SECRET',
  },
  BEARER_TOKEN: {},
  USER_ID: {},
  HOST: {
    from: 'HEROKU_APP_NAME',
    parse: (value) => `${value}.herokuapp.com`,
    default: '127.0.0.1:3000',
  },
  REDIRECT_HOST: {
    default: null,
  },
  PORT: {
    parse: (value) => parseInt(value),
    default: 3000,
  },
  REDIS_URL: {
    default: 'redis://localhost:6379',
  },
  SECRET: {
    default:
      '#ウ考寝  #そ無寝しぽ👋 おやすみなさい　テレビの発熱はかなりデカいので、こういう日に締め切った部屋でテレビゲームをし続けるのはやめた方がいい',
  },
  PRODUCTION: {
    from: 'NODE_ENV',
    parse: (value) => value === 'production',
    default: false,
  },
});

const redirectUri = `https://${REDIRECT_HOST ?? HOST}/callback`;

const app = fastify({
  logger: !PRODUCTION,
});
app.register(fastifyCookie);
app.register(FastifySessionPlugin, {
  secret: SECRET,
  cookie: {
    secure: PRODUCTION,
    sameSite: 'none',
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 * 7,
    path: '/',
    domain: REDIRECT_HOST ?? HOST,
  },
});
app.register(fastifyRedis, {
  url: REDIS_URL,
});
app.register(fastifyStatic, {
  root: path.join(process.cwd(), 'public'),
});

const api = new TwitterApi(CLIENT);

app.get('/login', async (request, reply) => {
  const {
    url: authUrl,
    codeVerifier,
    state,
  } = api.generateOAuth2AuthLink(redirectUri, {
    scope: ['tweet.read', 'like.write', 'users.read', 'offline.access'],
  });

  request.session.set('state', state);
  request.session.set('codeVerifier', codeVerifier);
  await request.session.save();

  reply.redirect(authUrl);
});

function isValidCallbackQuery(
  query: unknown
): query is { code: string; state: string } {
  return (
    typeof query === 'object' &&
    query !== null &&
    'code' in query &&
    'state' in query
  );
}

app.get('/callback', async (request, reply) => {
  if (!isValidCallbackQuery(request.query)) {
    reply.code(400).send({ error: 'invalid request query type' });
    return;
  }

  const { code, state } = request.query;
  const storedState = request.session.get<string>('state');
  const codeVerifier = request.session.get<string>('codeVerifier');

  if (state !== storedState) {
    reply.code(400).send({ error: 'invalid state value' });
    return;
  }

  const loginResult = await api
    .loginWithOAuth2({
      code,
      redirectUri,
      codeVerifier,
    })
    .catch(() => null);

  if (!loginResult) {
    reply.code(400).send({ error: 'invalid code' });
    return;
  }

  const { client: loggedClient, expiresIn, ...token } = loginResult;

  const { data: user } = await loggedClient.currentUserV2();
  await app.redis.hset(
    'token',
    user.id,
    JSON.stringify({ ...token, expiresAt: Date.now() + expiresIn * 1000 })
  );

  reply.redirect('/');
});

async function stream() {
  const client = new TwitterApiReadOnly(BEARER_TOKEN);
  const rules = await client.v2.streamRules();
  await client.v2.updateStreamRules({
    delete: {
      ids: rules.data.map((rule) => rule.id),
    },
  });
  await client.v2.updateStreamRules({
    add: [
      {
        value: `from:${USER_ID}`,
        tag: 'ID filter',
      },
    ],
  });
  const stream = await client.v2.searchStream({
    'tweet.fields': ['id', 'text', 'source'],
    autoConnect: true,
  });

  stream.autoReconnect = true;

  for await (const { data: tweet } of stream) {
    if (tweet.source !== 'twittbot.net') continue;
    const tokens = await app.redis.hgetall('token');

    await Promise.all(
      Object.entries(tokens).map(([userId, token]) => {
        const { expiresAt, accessToken, refreshToken } = JSON.parse(
          token
        ) as Token;

        if (Date.now() > expiresAt && refreshToken) {
          return api
            .refreshOAuth2Token(refreshToken)
            .then(({ client, expiresIn, ...token }) =>
              Promise.all([
                app.redis.hset(
                  'token',
                  userId,
                  JSON.stringify({
                    ...token,
                    expiresAt: Date.now() + expiresIn * 1000,
                  })
                ),
                client.v2.like(userId, tweet.id),
              ])
            );
        } else {
          return new TwitterApi(accessToken).v2.like(userId, tweet.id);
        }
      })
    );
  }
}

stream();
app.listen(PORT);
