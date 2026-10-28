// Security checks: links the server opens never reach private addresses, forged senders are
// caught, and request values can't reach JavaScript built-ins.

import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it } from 'node:test';
import { simpleParser } from 'mailparser';
import { checkLink } from '../server/lib/linkCheck.js';
import { isHttpUrl } from '../server/lib/normalize.js';
import { BlockedUrlError, checkPublicUrl, isPrivateAddress, safeFetch } from '../server/lib/safeFetch.js';
import { emailToText, resolveJobLink, senderVerified } from '../server/sources/jobEmail.js';
import { feedFilters } from '../server/routes/jobs.js';

describe('links the server opens', () => {
  it('knows private and public addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'not-an-ip']) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
    for (const ip of ['8.8.8.8', '104.18.1.1', '2606:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPrivateAddress(ip), false, ip);
  });

  it('refuses links to this machine, private networks, odd ports and other schemes', () => {
    for (const url of [
      'http://localhost/admin',
      'http://127.0.0.1:3306/',
      'http://2130706433/', // 127.0.0.1 written as one number
      'http://0x7f.1/',
      'http://[::1]/',
      'http://169.254.169.254/latest/meta-data/',
      'http://192.168.1.1/',
      'http://db.internal/',
      'https://example.com:8443/',
      'https://user:pass@example.com/',
      'file:///etc/passwd',
      'ftp://example.com/',
      'javascript:alert(1)',
      'not a url',
    ]) {
      assert.throws(() => checkPublicUrl(url), BlockedUrlError, url);
      assert.equal(isHttpUrl(url), false, url);
    }
    for (const url of ['https://www.glassdoor.co.in/job/1', 'http://example.com:80/x', 'https://example.com:443/']) assert.ok(checkPublicUrl(url));
  });

  it('never connects to a local server, directly or through the link checks', async () => {
    let hits = 0;
    const server = http.createServer((req, res) => {
      hits += 1;
      res.end('secret');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    try {
      await assert.rejects(safeFetch(url), BlockedUrlError);
      await assert.rejects(safeFetch(`http://localhost:${server.address().port}/`), BlockedUrlError);
      assert.equal(await checkLink(url), 'unknown');
      assert.equal(await resolveJobLink(url), url, 'kept as it was, never opened');
      assert.equal(hits, 0);
    } finally {
      server.close();
    }
  });

  it('stops following a tracker that redirects to a private address', async () => {
    const fetchImpl = async (url) =>
      url === 'https://click.example.com/c/1' ? new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }) : assert.fail(`opened ${url}`);
    assert.equal(await resolveJobLink('https://click.example.com/c/1', { fetchImpl }), 'https://click.example.com/c/1');
  });

  it('leaves private-address links in an email out of the job list', () => {
    assert.equal(isHttpUrl('http://10.0.0.5/jobs'), false);
    const { links } = emailToText({ text: 'Intern https://studio.example.com/jobs/1' });
    assert.deepEqual(links, ['https://studio.example.com/jobs/1']);
  });
});

describe('who sent a job email', () => {
  const parse = async (headers, from = 'Glassdoor <noreply@glassdoor.com>') => {
    const mail = await simpleParser(Buffer.from([...headers, `From: ${from}`, 'Subject: Jobs for you', '', 'body'].join('\r\n')));
    return senderVerified(mail.headerLines, mail.from.value[0].address);
  };

  it('trusts Gmail\'s own check of the sender', async () => {
    assert.equal(await parse(['Authentication-Results: mx.google.com;\r\n       dkim=pass header.i=@glassdoor.com;\r\n       spf=pass smtp.mailfrom=bounce@em.glassdoor.com;\r\n       dmarc=pass (p=REJECT) header.from=glassdoor.com']), true);
    assert.equal(await parse(['Authentication-Results: mx.google.com; dkim=pass header.i=@em.glassdoor.com; dmarc=none']), true);
    assert.equal(await parse([]), true, 'never came from outside: her own mail');
  });

  it('catches a forged sender, even with a fake "pass" lower down', async () => {
    assert.equal(
      await parse(['Authentication-Results: mx.google.com; spf=softfail smtp.mailfrom=x@attacker.example; dmarc=fail header.from=glassdoor.com', 'Authentication-Results: mx.google.com; dmarc=pass']),
      false,
    );
    assert.equal(await parse(['Authentication-Results: mx.google.com; dkim=pass header.i=@attacker.example; spf=pass smtp.mailfrom=a@attacker.example; dmarc=fail']), false);
    assert.equal(await parse(['Authentication-Results: attacker.example; dmarc=pass']), false, 'only Google\'s header counts');
  });
});

describe('request values', () => {
  it('cannot reach Object built-ins through filter names', () => {
    for (const apply of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const { where, params } = feedFilters({ apply, city: 'all' });
      assert.doesNotMatch(where, /apply_kind IN/, apply);
      assert.ok(!params.some((p) => typeof p === 'function'), apply);
    }
  });
});
