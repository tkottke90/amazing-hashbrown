import React from 'react';
import { Textarea, Label } from 'amazing-hashbrown-ui';

export function Default() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '24px', maxWidth: '360px' }}>
      <Label htmlFor="bio">Bio</Label>
      <Textarea id="bio" placeholder="Tell us about yourself…" rows={4} />
    </div>
  );
}

export function States() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '24px', maxWidth: '360px' }}>
      <Textarea placeholder="Default textarea" rows={3} />
      <Textarea placeholder="Disabled" disabled rows={3} />
      <Textarea aria-invalid="true" defaultValue="Invalid content" rows={3} />
    </div>
  );
}
