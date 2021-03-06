/**
 * This code is heavily inspired from
 * https://github.com/JsCommunity/make-error/blob/v1.3.4/index.js
 * ...but more modified than expected :-D
 * Below is the original license anyway:
 *
 * ---
 *
 * The MIT License (MIT)
 *
 * Copyright (c) 2014 Blake Embrey (hello@blakeembrey.com)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

import { Logger } from 'bs-logger'
import { readFileSync, writeFileSync } from 'fs'
import mkdirp = require('mkdirp')
import { basename, extname, join, normalize } from 'path'

import { ConfigSet } from '../config/config-set'
import { CompileResult, MemoryCache, TsCompiler } from '../types'
import { sha1 } from '../util/sha1'

import { compileUsingLanguageService } from './language-service'
import { compileUsingProgram } from './program'
import { compileUsingTranspileModule } from './transpile-module'

/**
 * Update the output remapping the source map.
 */
function updateOutput(
  outputText: string,
  normalizedFileName: string,
  sourceMap: string,
  getExtension: (fileName: string) => string,
) {
  const base = basename(normalizedFileName)
  const base64Map = Buffer.from(updateSourceMap(sourceMap, normalizedFileName), 'utf8').toString('base64')
  const sourceMapContent = `data:application/json;charset=utf-8;base64,${base64Map}`
  const sourceMapLength =
    `${base}.map`.length + (getExtension(normalizedFileName).length - extname(normalizedFileName).length)

  return outputText.slice(0, -sourceMapLength) + sourceMapContent
}

/**
 * Update the source map contents for improved output.
 */
const updateSourceMap = (sourceMapText: string, normalizedFileName: string): string => {
  const sourceMap = JSON.parse(sourceMapText)
  sourceMap.file = normalizedFileName
  sourceMap.sources = [normalizedFileName]
  delete sourceMap.sourceRoot

  return JSON.stringify(sourceMap)
}

/**
 * Get the file name for the cache entry.
 */
const getCacheName = (sourceCode: string, normalizedFileName: string): string => {
  return sha1(normalizedFileName, '\x00', sourceCode)
}

/**
 * Ensure the given cached content is valid by sniffing for a base64 encoded '}'
 * at the end of the content, which should exist if there is a valid sourceMap present.
 */
const isValidCacheContent = (contents: string): boolean => {
  return /(?:9|0=|Q==)$/.test(contents.slice(-3))
}

/**
 * Wrap the function with caching.
 */
const readThrough = (
  cachedir: string | undefined,
  memoryCache: MemoryCache,
  compile: CompileResult,
  getExtension: (fileName: string) => string,
  logger: Logger,
) => {
  if (!cachedir) {
    return (code: string, fileName: string, lineOffset?: number) => {
      const normalizedFileName = normalize(fileName)
      logger.debug({ normalizedFileName }, 'readThrough(): no cache')
      const [value, sourceMap] = compile(code, normalizedFileName, lineOffset)
      const output = updateOutput(value, fileName, sourceMap, getExtension)
      memoryCache.outputs.set(normalizedFileName, output)

      return output
    }
  }

  // Make sure the cache directory exists before continuing.
  mkdirp.sync(cachedir)

  return (code: string, fileName: string, lineOffset?: number) => {
    const normalizedFileName = normalize(fileName)
    const cachePath = join(cachedir, getCacheName(code, normalizedFileName))
    const extension = getExtension(normalizedFileName)
    const outputPath = `${cachePath}${extension}`

    try {
      const output = readFileSync(outputPath, 'utf8')
      if (isValidCacheContent(output)) {
        logger.debug({ normalizedFileName }, 'readThrough(): cache hit')
        memoryCache.outputs.set(normalizedFileName, output)

        return output
      }
    } catch (err) {}

    logger.debug({ fileName }, 'readThrough(): cache miss')
    const [value, sourceMap] = compile(code, normalizedFileName, lineOffset)
    const output = updateOutput(value, normalizedFileName, sourceMap, getExtension)

    logger.debug({ normalizedFileName, outputPath }, 'readThrough(): writing caches')
    memoryCache.outputs.set(normalizedFileName, output)
    writeFileSync(outputPath, output)

    return output
  }
}

/**
 * Register TypeScript compiler.
 * @internal
 */
export const createCompiler = (configs: ConfigSet): TsCompiler => {
  const logger = configs.logger.child({ namespace: 'ts-compiler' })
  const {
    typescript: { options: compilerOptions, fileNames },
    tsJest,
  } = configs
  const cachedir = configs.tsCacheDir,
    ts = configs.compilerModule, // Require the TypeScript compiler and configuration.
    extensions = ['.ts', '.tsx'],
    memoryCache: MemoryCache = {
      contents: new Map<string, string | undefined>(),
      versions: new Map<string, number>(),
      outputs: new Map<string, string>(),
    }
  // Enable `allowJs` when flag is set.
  if (compilerOptions.allowJs) {
    extensions.push('.js')
    extensions.push('.jsx')
  }
  // Initialize files from TypeScript into project.
  for (const path of fileNames) memoryCache.versions.set(normalize(path), 1)
  /**
   * Get the extension for a transpiled file.
   */
  const getExtension =
    compilerOptions.jsx === ts.JsxEmit.Preserve
      ? (path: string) => (/\.[tj]sx$/.test(path) ? '.jsx' : '.js')
      : (_: string) => '.js'
  let compileResult: CompileResult
  if (!tsJest.isolatedModules) {
    // Use language services by default
    if (!tsJest.compilerHost) {
      compileResult = compileUsingLanguageService(configs, logger, memoryCache)
    } else {
      compileResult = compileUsingProgram(configs, logger, memoryCache)
    }
  } else {
    compileResult = compileUsingTranspileModule(configs, logger)
  }
  const compile = readThrough(cachedir, memoryCache, compileResult, getExtension, logger)

  return { cwd: configs.cwd, compile, extensions, cachedir, ts }
}
