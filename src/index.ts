import { TwitterApi } from 'twitter-api-v2';
import fastify from 'fastify';
import fastifyStatic from 'fastify-static';
import fastifyCookie from '@fastify/cookie';
import FastifySessionPlugin from '@fastify/session';
import fastifyRedis from '@fastify/redis';
import path from 'path';
import readenv from '@cm-ayf/readenv';

if (process.env.NODE_ENV !== 'production')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('dotenv').config();

const PORT = 3000;

const { HOST, PRODUCTION, REDIS_URL, REDIRECT_HOST, SECRET, ...CLIENT } =
  readenv({
    clientId: {
      from: 'CLIENT_ID',
    },
    clientSecret: {
      from: 'CLIENT_SECRET',
    },
    REDIS_URL: {
      default: 'redis://localhost:6379',
    },
    HOST: {
      from: 'HEROKU_APP_NAME',
      parse: (value) => `${value}.herokuapp.com`,
      default: `127.0.0.1:${PORT}`,
    },
    REDIRECT_HOST: {
      default: null,
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

const api = new TwitterApi(CLIENT);

app.register(fastifyStatic, {
  root: path.join(process.cwd(), 'public'),
});

app.addHook('onRequest', (request, _, done) => {
  request.log.info(request.session.sessionId);
  done();
});

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

  const loginResult = await api.loginWithOAuth2({
    code,
    redirectUri,
    codeVerifier,
  });

  if (!loginResult) {
    reply.code(400).send({ error: 'invalid code' });
    return;
  }

  const { client: loggedClient, expiresIn, ...token } = loginResult;

  const { data: user } = await loggedClient.currentUserV2();
  await app.redis.set(
    `token_${user.id}`,
    JSON.stringify({ ...token, expiresAt: Date.now() + expiresIn * 1000 })
  );

  reply.redirect('/');
});

app.listen(PORT);
