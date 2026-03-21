const { execSync } = require('child_process');

try {
  console.log('Testing TypeScript compilation...');
  const result = execSync('npx tsc --noEmit', { encoding: 'utf8', cwd: __dirname });
  console.log('Compilation successful!');
  console.log('Output:', result);
} catch (error) {
  console.error('Compilation failed:', error.message);
  process.exit(1);
}
