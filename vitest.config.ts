import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // 对拍含数千个小程序，给足超时
    testTimeout: 30000,
    reporters: ['default'],
  },
});
