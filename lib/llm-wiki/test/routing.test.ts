import { expect } from 'chai';
import { parseRoutingNotes, scoreWiki, computeRouting } from '../src/internal/routing.js';
import type { WikiEntry } from '../src/types.js';

const homelab: WikiEntry = {
  id: 'homelab',
  path: 'homelab',
  domain: 'infrastructure and services',
  tags: ['dns', 'proxy', 'docker'],
  status: 'active',
};
const fitness: WikiEntry = {
  id: 'health-fitness',
  path: 'health-fitness',
  domain: 'training and nutrition',
  tags: ['cardio', 'strength'],
  status: 'active',
};

describe('routing/parseRoutingNotes', () => {
  it('parses triggers and target from a note', () => {
    const [note] = parseRoutingNotes(['DNS, reverse proxy, Docker -> homelab']);
    expect(note?.target).to.equal('homelab');
    expect(note?.triggers).to.include('dns');
    expect(note?.triggers).to.include('reverse proxy');
  });

  it('supports the unicode arrow', () => {
    const [note] = parseRoutingNotes(['cardio → health-fitness']);
    expect(note?.target).to.equal('health-fitness');
  });

  it('ignores lines without an arrow', () => {
    expect(parseRoutingNotes(['just a comment'])).to.have.length(0);
  });
});

describe('routing/scoreWiki', () => {
  it('scores id match highest', () => {
    expect(scoreWiki(homelab, 'my homelab setup', [])).to.be.greaterThan(0);
  });

  it('adds routing-note trigger weight only for the targeted wiki', () => {
    const notes = parseRoutingNotes(['reverse proxy, dns -> homelab']);
    const withNote = scoreWiki(homelab, 'setting up a reverse proxy', notes);
    const withoutNote = scoreWiki(homelab, 'setting up a reverse proxy', []);
    expect(withNote).to.be.greaterThan(withoutNote);
  });
});

describe('routing/computeRouting', () => {
  const wikis = [homelab, fitness];
  const notes = ['dns, proxy, docker -> homelab', 'cardio, strength -> health-fitness'];

  it('returns a single match when one wiki dominates', () => {
    const r = computeRouting(wikis, notes, 'configure DNS on the docker host');
    expect(r.kind).to.equal('match');
    expect(r.winner?.entry.id).to.equal('homelab');
  });

  it('returns no_match when nothing scores', () => {
    const r = computeRouting(wikis, notes, 'the weather is nice today');
    expect(r.kind).to.equal('no_match');
    expect(r.available).to.have.length(2);
  });

  it('returns ambiguous on a tie', () => {
    const r = computeRouting(wikis, [], 'dns cardio'); // one tag each → tie at 3
    expect(r.kind).to.equal('ambiguous');
    expect(r.candidates).to.have.length(2);
  });

  it('excludes archived wikis', () => {
    const archived = { ...fitness, status: 'archived' as const };
    const r = computeRouting([homelab, archived], notes, 'cardio strength');
    expect(r.kind).to.equal('no_match');
  });
});
