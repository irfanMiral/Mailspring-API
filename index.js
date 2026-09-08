import * as dotenv from 'dotenv';
import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import axios from 'axios';
import winston from 'winston';
import crypto from 'crypto';
import cryptoRandomString from 'crypto-random-string';
import Database from 'better-sqlite3';
import translate from '@iamtraction/google-translate';
import fs from 'fs';
import path from 'path';
import dns from 'dns';
import { promisify } from 'util';

const resolveSrv = promisify(dns.resolveSrv);

// Looks up an RFC 6764 DAV discovery SRV record (e.g. "_caldavs._tcp.example.com")
// and returns the highest-priority target's host name, or null if none exists.
async function resolveDavSrvHost(srvName) {
    try {
        const records = await resolveSrv(srvName);
        if(!records.length) return null;
        records.sort((a, b) => a.priority - b.priority || b.weight - a.weight);
        return records[0].name;
    } catch(err) {
        return null;
    }
}

dotenv.config();
const API_PORT = process.env.API_PORT || 5101;

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({format: 'YYYY-MM-DD HH:mm:ss'}),
        winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`)
    ),
    transports: [
        new winston.transports.Console()
    ]
});
const app = express();
const upload = multer();

if(!fs.existsSync('./data')) {
    fs.mkdirSync('./data');
}
const db = new Database('./data/mailspring-api.db');
// WAL lets readers/writers work concurrently instead of locking the whole file, and
// busy_timeout makes a writer that does show up (e.g. manage.js) retry for a bit
// instead of failing immediately with SQLITE_BUSY - both matter here because manage.js
// opens its own separate connection to the same file while the server is running.
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.transaction(() => {
    db.exec('CREATE TABLE IF NOT EXISTS identities(id VARCHAR PRIMARY KEY, firstName VARCHAR, lastName VARCHAR, emailAddress VARCHAR, passwordHash VARCHAR, createdAt VARCHAR, stripePlan VARCHAR, stripePlanEffective VARCHAR, stripeCustomerId VARCHAR, stripePeriodEnd VARCHAR, featureUsage VARCHAR);');
    db.exec('CREATE TABLE IF NOT EXISTS sessions(token VARCHAR PRIMARY KEY, identityId VARCHAR, lastLogin INTEGER);');
    db.exec('CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, event VARCHAR, object VARCHAR, objectId INTEGER, identityId VARCHAR, accountId VARCHAR, timestamp INTEGER);')
    db.exec('CREATE TABLE IF NOT EXISTS objects(id INTEGER PRIMARY KEY AUTOINCREMENT, object_id VARCHAR, object VARCHAR, object_type VARCHAR, aid VARCHAR, identity_id VARCHAR, plugin_id VARCHAR, v INTEGER, value VARCHAR, timestamp INTEGER);');
    db.exec('CREATE TABLE IF NOT EXISTS shared_pages(id INTEGER PRIMARY KEY AUTOINCREMENT, identityId VARCHAR, key VARCHAR, html VARCHAR, timestamp INTEGER);');
    db.exec('CREATE TABLE IF NOT EXISTS shared_assets(id INTEGER PRIMARY KEY AUTOINCREMENT, identityId VARCHAR, key VARCHAR, filename VARCHAR, filetype VARCHAR, file BLOB, timestamp INTEGER);');
})();
cleanup();

let sessions = [];

app.use(express.json({strict: false}));
app.use(cookieParser());
app.use((req, res, next) => {
    logger.debug(`${req.method} ${req.path}`);
    next();
});
// This server exists to sync a private mailbox, not to be discovered.
app.use((req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
});
app.use((req, res, next) => {
    const path = req.path;
    if(path.startsWith('/api') || path.startsWith('/metadata') || path.startsWith('/deltas')) {
        if(path == '/api/resolve-dav-hosts') {
            next();
            return;
        }

        if(req.headers.authorization) {
            const auth = req.headers.authorization.split(' ')[1];
            const token = Buffer.from(auth, 'base64').toString().slice(0, -1);

            // Check token
            const identity = verifySession(token);
            if(identity) {
                req.identity = identity;
                next();
            } else {
                res.status(401).header('WWW-Authenticate', 'Basic').json({statusCode: 401, error: 'Unauthorized', message: 'Invalid token'});
            }
        } else {
            res.status(401).header('WWW-Authenticate', 'Basic').json({statusCode: 401, error: 'Unauthorized', message: 'Missing authentication'});
        }
    } else {
        next();
    }
});

// Public
app.get('/', (req, res) => {
    res.sendFile(path.resolve('./static/index.html'));
});
app.get('/robots.txt', (req, res) => {
    res.sendFile(path.resolve('./static/robots.txt'));
});
app.get(/\/signature-assets\/[a-z0-9_-]+\.(gif|png)$/i, (req, res) => {
    // Social icons for the composer's default signature templates. Self-hosted here
    // instead of hotlinking getmailspring.com, both to drop that dependency and so we
    // can keep them current (e.g. Twitter -> X) independently of upstream.
    const filename = path.basename(req.path);
    const filePath = path.resolve('./static/signature-assets', filename);
    if(!filePath.startsWith(path.resolve('./static/signature-assets'))) {
        res.status(400).end();
        return;
    }
    res.sendFile(filePath, err => {
        if(err) res.status(404).end();
    });
});
app.get(/\/open\/.+/, (req, res) => {
    res.sendFile(path.resolve('./static/blank.gif'));

    const messageId = req.path.match(/\/open\/(.+)/)[1];
    const accountId = req.query.me;
    const recipient = Buffer.from(req.query.recipient, 'base64').toString();
    
    db.transaction(() => {
        let stmt = db.prepare('SELECT * FROM objects WHERE object = \'metadata\' AND plugin_id = \'open-tracking\' AND aid = ? AND json_extract(value, \'$.uid\') = ?;');
        let object = stmt.get(accountId, messageId);
        
        if(object) {
            object.v++;
            object.value = JSON.parse(object.value);
            object.value.open_count++;
            object.value.open_data.push({
                timestamp: Date.now()/1000,
                recipient: recipient
            });
    
            stmt = db.prepare('UPDATE objects SET v = ?, value = ? WHERE id = ?;');
            stmt.run(object.v, JSON.stringify(object.value), object.id);
    
            emitEvent('modify', object);
        }
    })();
});
app.get(/\/link\/.+\/.+/, (req, res) => {
    const redirectUrl = req.query.redirect;
    if(!redirectUrl) {
        res.status(404).end("Expired or broken link.");
        return;
    }
    res.redirect(redirectUrl);

    const pathValues = req.path.match(/\/link\/(.+)\/(.+)/);
    const messageId = pathValues[1];
    const linkId = pathValues[2];
    const recipient = Buffer.from(req.query.recipient, 'base64').toString();

    db.transaction(() => {
        let stmt = db.prepare('SELECT * FROM objects WHERE object = \'metadata\' AND plugin_id = \'link-tracking\' AND json_extract(value, \'$.uid\') = ?;');
        let object = stmt.get(messageId);

        if(object) {
            object.v++;
            object.value = JSON.parse(object.value);
            const link = object.value.links[linkId];
            if(link) {
                link.click_count++;
                link.click_data.push({
                    timestamp: Date.now()/1000,
                    recipient: recipient
                });

                stmt = db.prepare('UPDATE objects SET v = ?, value = ? WHERE id = ?;');
                stmt.run(object.v, JSON.stringify(object.value), object.id);
        
                emitEvent('modify', object);
            }
        }
    })();
});
app.get(/\/page\/.+/, (req, res) => {
    const key = req.path.match(/\/page\/(.+)/)[1];

    const stmt = db.prepare('SELECT html FROM shared_pages WHERE key = ?;');
    const data = stmt.get(key);

    if(data) {
        res.send(data.html);
    } else {
        res.status(404).end('Invalid or expired link.');
    }
});
app.get(/\/asset\/.+/, (req, res) => {
    const key = req.path.match(/\/asset\/(.*)?\.[^.]*$/)[1];

    const stmt = db.prepare('SELECT file, filetype FROM shared_assets WHERE key = ?;');
    const data = stmt.get(key);

    if(data) {
        res.setHeader('Content-Type', data.filetype);
        res.send(data.file);
    } else {
        res.status(404).end('Invalid or expired link.');
    }
});
app.get(/\/thread\/.*\/.*/, (req, res) => {
    const pathValues = req.path.match(/\/thread\/(.*)\/(.*)/);
    const identityId = pathValues[1];
    const key = pathValues[2];

    const stmt = db.prepare('SELECT file FROM shared_assets WHERE identityId = ? AND filename = ?;');
    const asset = stmt.get(identityId, key);

    if(asset) {
        try {
            const thread = JSON.parse(asset.file);
            if(thread.shared != false) {
                res.render(path.resolve('./static/thread-sharing.ejs'), {data: thread, title: 'test'});
            } else {
                res.status(404).end('Invalid or expired link. Has the person stopped sharing this thread?');
            }
        } catch(e) {
            res.status(404).end('Invalid or expired link. Has the person stopped sharing this thread?');
        }
    } else {
        res.status(404).end('Invalid or expired link. Has the person stopped sharing this thread?');
    }
});

// Accout related
app.get('/dashboard', (req, res) => {
    // This is what the Mailspring client's "Account Details" / "Manage Billing"
    // buttons open (via /api/login-link), so it needs to be a real account page,
    // not just a redirect to the static landing page.
    const identity = verifySession(req.cookies.session);
    if(!identity) {
        res.sendFile(path.resolve('./static/login.html'));
        return;
    }

    const stmt = db.prepare('SELECT token, lastLogin FROM sessions WHERE identityId = ? ORDER BY lastLogin DESC;');
    const sessionRows = stmt.all(identity.id);

    res.render(path.resolve('./static/dashboard.ejs'), {
        identity: identity,
        sessions: sessionRows,
        currentToken: identity.token
    });
});
app.post('/dashboard/change-password', (req, res) => {
    const identity = verifySession(req.cookies.session);
    if(!identity) {
        res.status(401).json({statusCode: 401, error: 'Unauthorized', message: 'Not logged in.'});
        return;
    }
    if(!req.body || !req.body.currentPassword || !req.body.newPassword) {
        res.status(400).json({statusCode: 400, error: 'Bad Request', message: 'Current and new password are required.'});
        return;
    }
    if(req.body.newPassword.length < 8) {
        res.status(400).json({statusCode: 400, error: 'Bad Request', message: 'New password must be at least 8 characters.'});
        return;
    }

    const stmt = db.prepare('SELECT passwordHash FROM identities WHERE id = ?;');
    const row = stmt.get(identity.id);
    const [correctHash, salt] = row.passwordHash.split('.');
    const currentHash = crypto.pbkdf2Sync(req.body.currentPassword, salt, 1000, 64, 'sha512').toString('hex');

    if(currentHash !== correctHash) {
        res.status(401).json({statusCode: 401, error: 'Unauthorized', message: 'Current password is incorrect.'});
        return;
    }

    db.transaction(() => {
        let stmt = db.prepare('UPDATE identities SET passwordHash = ? WHERE id = ?;');
        stmt.run(hashPassword(req.body.newPassword), identity.id);

        // Sign out everywhere except this browser session, same as manage.js changepw.
        stmt = db.prepare('DELETE FROM sessions WHERE identityId = ? AND token != ?;');
        stmt.run(identity.id, identity.token);
    })();

    logger.info(`User "${identity.firstName} ${identity.lastName}" changed their password via the dashboard.`);
    res.json({success: true});
});
app.post('/dashboard/sessions/revoke', (req, res) => {
    const identity = verifySession(req.cookies.session);
    if(!identity) {
        res.status(401).json({statusCode: 401, error: 'Unauthorized', message: 'Not logged in.'});
        return;
    }
    if(!req.body || !req.body.token) {
        res.status(400).json({statusCode: 400, error: 'Bad Request', message: 'Key "token" is required.'});
        return;
    }

    // Scoped to this identity so one user can't revoke another's session by guessing a token.
    const stmt = db.prepare('DELETE FROM sessions WHERE token = ? AND identityId = ?;');
    stmt.run(req.body.token, identity.id);

    res.json({success: true, signedOutCurrentSession: req.body.token === identity.token});
});
app.post('/dashboard/logout', (req, res) => {
    const identity = verifySession(req.cookies.session);
    if(identity) {
        const stmt = db.prepare('DELETE FROM sessions WHERE token = ?;');
        stmt.run(identity.token);
    }
    res.clearCookie('session');
    res.redirect('/dashboard');
});
app.get('/onboarding', (req, res) => {
    const identity = verifySession(req.cookies.session);
    if(identity) {
        const identityEncoded = Buffer.from(JSON.stringify(identity)).toString('base64');
        res.render(path.resolve('./static/onboarding.ejs'), {identityEncoded: identityEncoded});
    } else {
        res.sendFile(path.resolve('./static/login.html'));
    }
});
app.post('/login', (req, res) => {
    if(!req.body) {
        res.status(400).json({statusCode: 400, error: 'Bad Request', message: 'No data provided'});
        return;
    }
    if(!req.body.emailAddress) {
        res.status(400).json({statusCode: 400, error: 'Bad Request', message: 'Key "emailAddress" is required'});
        return;
    }
    if(!req.body.password) {
        res.status(400).json({statusCode: 400, error: 'Bad Request', message: 'Key "password" is required'});
        return;
    }

    const identity = loginUser(req.body.emailAddress, req.body.password);
    if(identity.error) {
        res.status(identity.statusCode);
    } else {
        res.cookie('session', identity.token);
    }
    res.json(identity);
});

// API
app.post('/api/resolve-dav-hosts', async (req, res) => {
    // Locates candidate CalDAV/CardDAV hosts for the account's domain via RFC 6764
    // DNS SRV discovery. The client verifies/walks each host itself (.well-known
    // redirect + PROPFIND chain), so we only need to hand back a host name, not a
    // fully resolved service URL.
    const domain = req.body && req.body.domain;
    if(!domain) {
        res.status(400).json({statusCode: 400, error: 'Bad Request', message: 'Key "domain" is required'});
        return;
    }

    const result = {};
    result.caldavHost = await resolveDavSrvHost('_caldavs._tcp.' + domain) || req.body.imapHost || domain;
    result.carddavHost = await resolveDavSrvHost('_carddavs._tcp.' + domain) || req.body.imapHost || domain;
    res.json(result);
});
app.post('/api/feature_usage_event', (req, res) => {
    // Don't do anything, unlimitted use of features
    res.json({sucess: true})
});
app.get('/api/me', (req, res) => {
    // Mark session as still active
    const stmt = db.prepare('UPDATE sessions SET lastLogin = ? WHERE token = ?;');
    stmt.run(Math.round(Date.now()/1000), req.identity.token);

    delete req.identity.token;
    res.json(req.identity);
});
app.post('/api/share-static-page', (req, res) => {
    if(!req.body) {
        res.status(400).json({statusCode: 400, error: 'Bad Request', message: 'No data provided'});
        return;
    }
    if(!req.body.html) {
        res.status(400).json({statusCode: 400, error: 'Bad Request', message: 'Key "html" is required'});
        return;
    }

    const key = cryptoRandomString({length: 40, type: 'alphanumeric'});
    const baseUrl = process.env.SHARE_URL || 'http://localhost:5101';

    const stmt = db.prepare('INSERT INTO shared_pages(identityId, key, html, timestamp) VALUES (?, ?, ?, ?);');
    stmt.run(req.identity.id, key, req.body.html, Math.round(Date.now()/1000));

    res.json({link: baseUrl+'/page/'+key});
});
app.post('/api/save-public-asset', upload.single('file'), (req, res) => {
    if(!req.body) {
        res.status(400).json({statusCode: 400, error: 'Bad Request', message: 'No data provided'});
        return;
    }
    if(!req.body.filename) {
        res.status(400).json({statusCode: 400, error: 'Bad Request', message: 'Key "filename" is required'});
        return;
    }
    if(!req.body.file && !req.file) {
        res.status(400).json({statusCode: 400, error: 'Bad Request', message: 'Key "file" is required'});
        return;
    }

    let blob, type;
    if(req.file) {
        blob = req.file.buffer;
        type = req.file.mimetype;
    } else {
        blob = req.body.file;
        type = 'text/plain';
    }

    db.transaction(() => {
        let stmt = db.prepare('SELECT * FROM shared_assets WHERE identityId = ? AND filename = ?;');
        let asset = stmt.get(req.identity.id, req.body.filename);
        const baseUrl = process.env.SHARE_URL || 'http://localhost:5101';

        if(asset) {
            // Update existing
            stmt = db.prepare('UPDATE shared_assets SET file = ?, filetype = ? WHERE id = ?;');
            stmt.run(blob, type, asset.id);

            res.json({link: baseUrl+'/asset/'+asset.key+path.extname(asset.filename)});
        } else {
            // Create new
            const key = cryptoRandomString({length: 50, type: 'alphanumeric'});

            stmt = db.prepare('INSERT INTO shared_assets(identityId, key, filename, filetype, file, timestamp) VALUES (?, ?, ?, ?, ?, ?);');
            stmt.run(req.identity.id, key, req.body.filename, type, blob, Math.round(Date.now()/1000));

            res.json({link: baseUrl+'/asset/'+key+path.extname(req.body.filename)});
        }
    })();
});
app.post('/api/translate', async (req, res) => {
    if(!req.body) {
        res.status(400).json({statusCode: 400, error: 'Bad Request', message: 'No data provided'});
        return;
    }
    if(!req.body.lang) {
        res.status(400).json({statusCode: 400, error: 'Bad Request', message: 'Key "lang" is required'});
        return;
    }
    if(!req.body.text) {
        res.status(400).json({statusCode: 400, error: 'Bad Request', message: 'Key "text" is required'});
        return;
    }

    if(req.body.lang == 'zh') req.body.lang = 'zh-cn';
    const paragraphs = Array.from(req.body.text.matchAll(/<b>(.+?)<\/b>/g)).map(p => p[1]);
    try {
        const result = await translate(paragraphs.join('\n'), { to: req.body.lang });
        
        const translations = result.text.split('\n').map(p => '<b>'+p+'</b>');
        res.json({result: translations.join('')});
    } catch(err) {
        logger.error('Message translation failed: '+err);
        res.status(500).json({statusCode: 500, error: 'Internal Server Error', message: 'Translation service returned an unexpected error.'});
    }
});
app.post('/api/grammar/check', async (req, res) => {
    if(!req.body || !req.body.text) {
        res.status(400).json({statusCode: 400, error: 'Bad Request', message: 'Key "text" is required'});
        return;
    }

    // Proxies to a LanguageTool-compatible server (https://languagetool.org). Defaults to
    // the public LanguageTool API, which is rate-limited; set LANGUAGETOOL_URL to point at
    // a self-hosted instance (e.g. the erikvl87/languagetool Docker image) to avoid that.
    const languageToolUrl = process.env.LANGUAGETOOL_URL || 'https://api.languagetool.org';
    try {
        const params = new URLSearchParams();
        params.append('text', req.body.text);
        params.append('language', req.body.language || 'auto');

        const result = await axios.post(languageToolUrl + '/v2/check', params);
        res.json(result.data);
    } catch(err) {
        if(err.response && err.response.status === 429) {
            res.status(429).json({statusCode: 429, error: 'Too Many Requests', message: 'Grammar check rate limit reached, please try again shortly.'});
            return;
        }
        logger.error('Grammar check failed: '+err);
        res.status(502).json({statusCode: 502, error: 'Bad Gateway', message: 'Grammar check service is temporarily unavailable.'});
    }
});
app.post('/api/login-link', upload.none(), (req, res) => {
    // This server has no separate SSO/billing portal, so there's nothing to sign a
    // login link for - just hand the client back the path it asked to open.
    const nextPath = (req.body && req.body.next_path) || '/';
    res.json({path: nextPath});
});

// Metadata
app.post(/\/metadata\/.+\/.+\/.+/, (req, res) => {
    const pathValues = req.path.match(/\/metadata\/(.+)\/(.+)\/(.+)/);
    const accountId = pathValues[1];
    const objectId = pathValues[2];
    const pluginId = pathValues[3];

    if(!req.body) {
        res.status(400).json({statusCode: 400, error: 'Bad Request', message: 'No data provided'});
        return;
    }
    if(!req.body.objectType) {
        res.status(400).json({statusCode: 400, error: 'Bad Request', message: 'Key "objectType" is required'});
        return;
    }
    if(!req.body.value) {
        res.status(400).json({statusCode: 400, error: 'Bad Request', message: 'Key "value" is required'});
        return;
    }
    if(!req.body.version) {
        res.status(400).json({statusCode: 400, error: 'Bad Request', message: 'Key "version" is required'});
        return;
    }

    let stmt = db.prepare('SELECT * FROM objects WHERE object = \'metadata\' AND object_id = ? AND object_type = ? AND aid = ? AND plugin_id = ? AND identity_id = ?;');
    let object = stmt.get(objectId, req.body.objectType, accountId, pluginId, req.identity.id);
    
    if(object) {
        // Update
        if(req.body.version >= object.v) {
            const previousValue = object.value;
            object.v++;
            object.value = req.body.value;
            const newValue = JSON.stringify(object.value);

            stmt = db.prepare('UPDATE objects SET v = ?, value = ? WHERE object = \'metadata\' AND object_id = ? AND object_type = ? AND aid = ? AND plugin_id = ? AND identity_id = ?;');
            stmt.run(object.v, newValue, objectId, req.body.objectType, accountId, pluginId, req.identity.id);
            
            logger.debug(`Updated object ${objectId} (v${object.v}) from ${previousValue} to ${newValue}`);
            emitEvent('modify', object);
            res.json(object);
        } else {
            res.status(409).json({statusCode: 409, error: 'Conflict', message: 'Version conflict'});
            return;
        }
    } else {
        // Create
        db.transaction(() => {
            stmt = db.prepare('INSERT INTO objects(object_id, object, object_type, aid, identity_id, plugin_id, v, value, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);');
            stmt.run(objectId, 'metadata', req.body.objectType, accountId, req.identity.id, pluginId, 1, JSON.stringify(req.body.value), Math.round(Date.now() / 1000));
            
            stmt = db.prepare('SELECT * FROM objects WHERE id = last_insert_rowid();');
            object = stmt.get();
            logger.debug(`Created object ${objectId} with value ${object.value}`);
            
            object.value = JSON.parse(object.value);
            emitEvent('create', object)
            res.json(object);
        })();
    }
});
app.get(/\/metadata\/.+/, (req, res) => {
    const accountId = req.path.match(/\/metadata\/(.+)/)[1];
    const limit = req.query.limit || 500;
    const offset = req.query.offset || 0;
    const stmt = db.prepare('SELECT * FROM objects WHERE object = \'metadata\' AND aid = ? AND identity_id = ? LIMIT ? OFFSET ?;');

    const objects = stmt.all(accountId, req.identity.id, limit, offset);
    objects.forEach(obj => {
        obj.value = JSON.parse(obj.value);
    });
    res.json(objects);
});
app.get(/\/deltas\/.+\/head/, (req, res) => {
    const accountId = req.path.match(/\/deltas\/(.+)\/head/)[1];
    const stmt = db.prepare('SELECT MAX(id) AS cursor FROM events WHERE identityId = ? AND accountId = ?;');
    const data = stmt.get(req.identity.id, accountId);
    res.json({cursor: data.cursor || 0});
});
app.get(/\/deltas\/.+\/streaming/, (req, res) => {
    if(!req.query.cursor) {
        res.status(400).json({statusCode: 400, error: 'Bad Request', message: 'Parameter "cursor" is required'});
        return;
    }
    const session = {
        send: (data) => {
            res.write(data+'\n');
        },
        sessionId: crypto.randomUUID(),
        identityId: req.identity.id,
        accountId: req.path.match(/\/deltas\/(.*)\/streaming/)[1],
        cursor: req.query.cursor
    };

    res.writeHead(200);
    db.transaction(() => {
        let stmt = db.prepare('SELECT * FROM events WHERE identityId = ? AND accountId = ? AND id > ?');
        let events = stmt.all(session.identityId, session.accountId, session.cursor);
        events.forEach(event => {
            event.cursor = event.id.toString();
            stmt = db.prepare('SELECT * FROM objects WHERE id = ?;');
            event.attributes = stmt.get(event.objectId);
            event.attributes.value = JSON.parse(event.attributes.value);

            res.write(JSON.stringify(event)+'\n');
        });
    })();

    // Heartbeat
    const heartbeatIntervall = setInterval(() => {
        res.write('\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n');
    }, 10000);

    // Close after 15min
    const sessionTimeout = setTimeout(() => {
        clearInterval(heartbeatIntervall);
        res.off('close', session.close);
        res.end();
        sessions = sessions.filter(s => s != session);
        logger.debug('Stream closed after 15min: '+JSON.stringify(session));
    }, 900000);

    session.close = () => {
        clearInterval(heartbeatIntervall);
        clearTimeout(sessionTimeout);
        res.end();
        sessions = sessions.filter(s => s != session);
        logger.debug('Stream closed: '+JSON.stringify(session));
    }
    sessions.push(session);

    res.on('close', session.close);
    logger.debug('Stream initialized: '+JSON.stringify(session));
});

app.listen(API_PORT, () => {
    logger.info(`Example app listening on port ${API_PORT}`)
});

function emitEvent(eventName, object) {
    db.transaction(() => {
        let stmt = db.prepare('INSERT INTO events(event, object, objectId, identityId, accountId, timestamp) VALUES (?, ?, ?, ?, ?, ?);');
        stmt.run(eventName, object.object, object.id, object.identity_id, object.aid, Math.round(Date.now() / 1000));
    
        stmt = db.prepare('SELECT * FROM events WHERE id = last_insert_rowid();');
        let event = stmt.get();
        event.cursor = event.id.toString();
        event.attributes = object;
        event = JSON.stringify(event);

        sessions.forEach(session => {
            if(session.identityId == object.identity_id && session.accountId == object.aid) {
                session.send(event);
            }
        });
    })();
}

function fetchIdentity(identityId) {
    const stmt = db.prepare('SELECT * FROM identities WHERE id = ?;');
    return stmt.get(identityId);
}
function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
    return hash+'.'+salt;
}
function loginUser(email, password) {
    const stmt = db.prepare('SELECT * FROM identities WHERE emailAddress = ?;');
    const identity = stmt.get(email);

    if(identity) {
        const pwHashSplit = identity.passwordHash.split('.');
        const pwSalt = pwHashSplit[1];
        const correctPwHash = pwHashSplit[0];
        const currentPwHash = crypto.pbkdf2Sync(password, pwSalt, 1000, 64, `sha512`).toString(`hex`);

        if(currentPwHash === correctPwHash) {
            delete identity.passwordHash;
            identity.token = createSession(identity.id);
            identity.featureUsage = JSON.parse(identity.featureUsage);
            logger.info(`User "${identity.firstName} ${identity.lastName}" sucessfully logged in.`);
            return identity;
        } else {
            logger.warn(`Login attempt for user "${identity.firstName} ${identity.lastName}" failed: Incorrect password.`);
            return {statusCode: 401, error: 'Unauthorized', message: 'Invalid email address or password.'};
        }
    } else {
        logger.warn(`Login attempt with email "${email}" failed: User not found.`)
        return {statusCode: 401, error: 'Unauthorized', message: 'Invalid email address or password.'};
    }
}
function createSession(identityId) {
    const token = crypto.randomUUID();
    const stmt = db.prepare('INSERT INTO sessions(token, identityId, lastLogin) VALUES (?, ?, ?);');
    stmt.run(token, identityId, Math.round(Date.now()/1000));
    return token;
}
function verifySession(token) {
    if(!token) return false;

    const stmt = db.prepare('SELECT * FROM sessions WHERE token = ?;');
    const session = stmt.get(token);
    if(session && session.lastLogin > Date.now()/1000 - 2629800) { // Expired after 1 month of inactivity
        const identity = fetchIdentity(session.identityId);
        delete identity.passwordHash;
        identity.token = token;
        identity.featureUsage = JSON.parse(identity.featureUsage);
        return identity;
    }
    return false;
}

function cleanup() {
    logger.info('Deleting expired sessions...');
    let stmt = db.prepare('DELETE FROM sessions WHERE lastLogin < ?;');
    let result = stmt.run(Date.now()/1000 - 2629800);
    logger.info(`Deleted ${result.changes} sessions`);
}

process.on('SIGINT', () => {
    process.exit();
});
