import React from 'react';
import { Checkbox, Label } from 'amazing-hashbrown-ui';

export function Default() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Checkbox id="terms" />
        <Label htmlFor="terms">Accept terms and conditions</Label>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Checkbox id="checked" defaultChecked />
        <Label htmlFor="checked">Checked by default</Label>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Checkbox id="disabled" disabled />
        <Label htmlFor="disabled" style={{ opacity: 0.5 }}>Disabled</Label>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Checkbox id="disabled-checked" disabled defaultChecked />
        <Label htmlFor="disabled-checked" style={{ opacity: 0.5 }}>Disabled + checked</Label>
      </div>
    </div>
  );
}
