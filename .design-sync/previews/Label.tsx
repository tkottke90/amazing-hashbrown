import React from 'react';
import { Label, Input, Checkbox } from 'amazing-hashbrown-ui';

export function Default() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '24px', maxWidth: '320px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <Label htmlFor="name">Full name</Label>
        <Input id="name" placeholder="Jane Smith" />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Checkbox id="agree" />
        <Label htmlFor="agree">I agree to the terms</Label>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <Label htmlFor="name-disabled" style={{ opacity: 0.5 }}>Disabled label</Label>
        <Input id="name-disabled" placeholder="Unavailable" disabled />
      </div>
    </div>
  );
}
