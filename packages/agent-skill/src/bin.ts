#!/usr/bin/env node
import { processMain } from './main.js';

process.exitCode = await processMain();
