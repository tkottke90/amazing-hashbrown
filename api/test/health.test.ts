import { expect } from 'chai';
import { createApp } from '../src/app.js';

describe('createApp', () => {
  it('builds an express app instance', () => {
    const app = createApp();
    expect(app).to.be.a('function');
  });
});
