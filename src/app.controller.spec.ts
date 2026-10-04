import { AppController } from './app.controller';

describe('AppController', () => {
  it('reports the configured target', async () => {
    const redis = {
      target: 'snug',
      host: '127.0.0.1',
      port: 6383,
      client: { ping: jest.fn().mockResolvedValue('PONG') },
    };
    const controller = new AppController(redis as never);
    const result = await controller.health();
    expect(result.ok).toBe(true);
    expect(result.target).toBe('snug');
    expect(result.port).toBe(6383);
  });
});
