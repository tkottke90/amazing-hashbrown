import React from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, Button } from 'amazing-hashbrown-ui';

export function Default() {
  return (
    <div style={{ padding: '24px', maxWidth: '380px' }}>
      <Card>
        <CardHeader>
          <CardTitle>Card Title</CardTitle>
          <CardDescription>Supporting description text for this card.</CardDescription>
        </CardHeader>
        <CardContent>
          <p style={{ color: 'var(--muted-foreground)', fontSize: '14px' }}>Card body content goes here. Add any components or text.</p>
        </CardContent>
        <CardFooter>
          <Button variant="outline" size="sm">Cancel</Button>
          <Button size="sm">Save</Button>
        </CardFooter>
      </Card>
    </div>
  );
}

export function SmallSize() {
  return (
    <div style={{ padding: '24px', maxWidth: '320px' }}>
      <Card size="sm">
        <CardHeader>
          <CardTitle>Compact Card</CardTitle>
          <CardDescription>Smaller card variant for dense UIs.</CardDescription>
        </CardHeader>
        <CardContent>
          <p style={{ color: 'var(--muted-foreground)', fontSize: '13px' }}>Reduced spacing for compact layouts.</p>
        </CardContent>
      </Card>
    </div>
  );
}
