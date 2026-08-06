import React from 'react';
import { Input, Label } from 'amazing-hashbrown-ui';

export function Default() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '24px', maxWidth: '320px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <Label htmlFor="email">Email address</Label>
        <Input id="email" type="email" placeholder="you@example.com" />
      </div>
    </div>
  );
}

export function States() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '24px', maxWidth: '320px' }}>
      <Input placeholder="Default" />
      <Input placeholder="Disabled" disabled />
      <Input placeholder="Read-only" readOnly defaultValue="Read-only value" />
      <Input aria-invalid="true" placeholder="Invalid" defaultValue="bad@" />
    </div>
  );
}

export function Types() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '24px', maxWidth: '320px' }}>
      <Input type="text" placeholder="Text input" />
      <Input type="password" placeholder="Password input" />
      <Input type="number" placeholder="Number input" />
      <Input type="search" placeholder="Search…" />
    </div>
  );
}
