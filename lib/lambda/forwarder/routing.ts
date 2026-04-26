export type RouteValue = string | string[];

export interface Routes {
  [localPart: string]: RouteValue;
}

export interface ResolveArgs {
  recipients: string[];
  domain: string;
  routes: Routes;
}

export function resolveDestinations(args: ResolveArgs): string[] {
  // Lower-case the routes keys ONCE for case-insensitive lookup
  const lowerRoutes: Routes = Object.fromEntries(
    Object.entries(args.routes).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const lowerDomain = args.domain.toLowerCase();
  const destinations = new Set<string>();

  for (const recipient of args.recipients) {
    const at = recipient.lastIndexOf('@');
    if (at < 0) continue;
    const localPart = recipient.slice(0, at).toLowerCase();
    const recipientDomain = recipient.slice(at + 1).toLowerCase();
    if (recipientDomain !== lowerDomain) continue;

    const match = lowerRoutes[localPart] ?? lowerRoutes['*'];
    if (!match) continue;

    if (Array.isArray(match)) {
      for (const m of match) destinations.add(m);
    } else {
      destinations.add(match);
    }
  }

  return Array.from(destinations);
}
