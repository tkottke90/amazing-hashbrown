import { expect } from 'chai';
import { createApp } from './app.js';

describe('createApp', () => {
  it('builds an express app instance', () => {
    const app = createApp();
    expect(app).to.be.a('function');
  });
});
