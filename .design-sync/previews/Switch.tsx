import React from 'react';
import { Switch, Label } from 'amazing-hashbrown-ui';

export function Default() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Switch id="notifications" />
        <Label htmlFor="notifications">Email notifications</Label>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Switch id="on" defaultChecked />
        <Label htmlFor="on">Dark mode (on)</Label>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Switch id="disabled-off" disabled />
        <Label htmlFor="disabled-off" style={{ opacity: 0.5 }}>Disabled (off)</Label>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Switch id="disabled-on" disabled defaultChecked />
        <Label htmlFor="disabled-on" style={{ opacity: 0.5 }}>Disabled (on)</Label>
      </div>
    </div>
  );
}
