/** jest 配置：ts-jest 转译 src 下的 .spec.ts */
export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: { esModuleInterop: true, experimentalDecorators: true, emitDecoratorMetadata: true, module: 'commonjs', target: 'ES2021', strict: false } }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
};
