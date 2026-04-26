import { resolveDestinations, Routes } from '../lib/lambda/forwarder/routing';

describe('resolveDestinations', () => {
  const DOMAIN = 'mydomain.com';

  it('returns the destination for a recipient whose local part maps to a single string route', () => {
    const routes: Routes = { info: 'a@gmail.com' };

    const result = resolveDestinations({
      recipients: ['info@mydomain.com'],
      domain: DOMAIN,
      routes,
    });

    expect(result).toEqual(['a@gmail.com']);
  });

  it('returns all destinations for a recipient whose local part maps to an array route', () => {
    const routes: Routes = { info: ['a@gmail.com', 'b@gmail.com'] };

    const result = resolveDestinations({
      recipients: ['info@mydomain.com'],
      domain: DOMAIN,
      routes,
    });

    expect(result).toHaveLength(2);
    expect(result).toEqual(expect.arrayContaining(['a@gmail.com', 'b@gmail.com']));
  });

  it('falls back to the wildcard route when the local part is not in routes', () => {
    const routes: Routes = { '*': 'catch@gmail.com' };

    const result = resolveDestinations({
      recipients: ['random@mydomain.com'],
      domain: DOMAIN,
      routes,
    });

    expect(result).toEqual(['catch@gmail.com']);
  });

  it('prefers the specific local-part route over the wildcard route', () => {
    const routes: Routes = { info: 'a@gmail.com', '*': 'catch@gmail.com' };

    const result = resolveDestinations({
      recipients: ['info@mydomain.com'],
      domain: DOMAIN,
      routes,
    });

    expect(result).toEqual(['a@gmail.com']);
    expect(result).not.toContain('catch@gmail.com');
  });

  it('returns an empty array when neither the local part nor a wildcard match', () => {
    const routes: Routes = { info: 'a@gmail.com' };

    const result = resolveDestinations({
      recipients: ['random@mydomain.com'],
      domain: DOMAIN,
      routes,
    });

    expect(result).toEqual([]);
  });

  it('ignores recipients whose domain does not match the configured domain', () => {
    const routes: Routes = { info: 'a@gmail.com' };

    const result = resolveDestinations({
      recipients: ['info@otherdomain.com'],
      domain: DOMAIN,
      routes,
    });

    expect(result).toEqual([]);
  });

  it('deduplicates destinations when multiple recipients route to the same address', () => {
    const routes: Routes = { info: 'a@gmail.com', support: 'a@gmail.com' };

    const result = resolveDestinations({
      recipients: ['info@mydomain.com', 'support@mydomain.com'],
      domain: DOMAIN,
      routes,
    });

    expect(result).toEqual(['a@gmail.com']);
  });

  it('fans out to multiple distinct destinations when recipients route differently', () => {
    const routes: Routes = { info: 'a@gmail.com', support: 'b@gmail.com' };

    const result = resolveDestinations({
      recipients: ['info@mydomain.com', 'support@mydomain.com'],
      domain: DOMAIN,
      routes,
    });

    expect(result).toHaveLength(2);
    expect(result).toEqual(expect.arrayContaining(['a@gmail.com', 'b@gmail.com']));
  });

  it('matches the local part case-insensitively', () => {
    const routes: Routes = { info: 'a@gmail.com' };

    const result = resolveDestinations({
      recipients: ['INFO@mydomain.com'],
      domain: DOMAIN,
      routes,
    });

    expect(result).toEqual(['a@gmail.com']);
  });

  it('matches the recipient domain case-insensitively', () => {
    const routes: Routes = { info: 'a@gmail.com' };

    const result = resolveDestinations({
      recipients: ['info@MyDomain.COM'],
      domain: DOMAIN,
      routes,
    });

    expect(result).toEqual(['a@gmail.com']);
  });

  it('handles a mix of specific routes, wildcard fallbacks, and wrong-domain recipients', () => {
    const routes: Routes = { info: 'a@gmail.com', '*': 'c@gmail.com' };

    const result = resolveDestinations({
      recipients: [
        'info@mydomain.com',
        'random@mydomain.com',
        'foo@elsewhere.com',
      ],
      domain: DOMAIN,
      routes,
    });

    expect(result).toHaveLength(2);
    expect(result).toEqual(expect.arrayContaining(['a@gmail.com', 'c@gmail.com']));
  });
});
