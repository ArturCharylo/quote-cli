#!/usr/bin/env node

import path from 'path';
import { existsSync } from 'fs';

// Resolve to the compiled JavaScript file
const entryPoint = path.join(process.env.PWD || process.cwd(), 'dist', 'index.js');

// Check if the compiled file exists
if (!existsSync(entryPoint)) {
    console.error('Error: Compiled CLI not found. Please run "npm run build" first.');
    process.exit(1);
}

// Run the compiled CLI
await import(entryPoint);