/*
 * Copyright 2025, Salesforce, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { z } from 'zod';

import { Connection, Org, SfError, SfProject } from '@salesforce/core';
import { SourceTracking } from '@salesforce/source-tracking';
import { ComponentSet, ComponentSetBuilder } from '@salesforce/source-deploy-retrieve';
import { ensureString } from '@salesforce/ts-types';
import { Duration } from '@salesforce/kit';
import { directoryParam, usernameOrAliasParam } from '../../shared/params.js';
import { textResponse } from '../../shared/utils.js';
import { getConnection } from '../../shared/auth.js';
import { SfMcpServer } from '../../sf-mcp-server.js';

const deployMetadataParams = z.object({
  sourceDir: z
    .array(z.string())
    .describe('Path to the local source files to deploy. Leave this unset if the user is vague about what to deploy.')
    .optional(),
  manifest: z.string().describe('Full file path for manifest (XML file) of components to deploy.').optional(),
  // 🆕 AJOUT du paramètre checkOnly
  checkOnly: z
    .boolean()
    .describe(
      `Validate deployment without actually deploying to the org.

AGENT INSTRUCTIONS:
Set this to true when user asks for:
- "validate", "check", "dry-run", "test deployment"
- "validate my code", "check compilation errors"
- "deploy --checkonly", "validation only"

Set to false or omit for actual deployments.
`
    )
    .optional(),
  // `RunSpecifiedTests` is excluded on purpose because the tool sets this level when Apex tests to run are passed in.
  //
  // Can be left unset to let the org decide which test level to use:
  // https://developer.salesforce.com/docs/atlas.en-us.api_meta.meta/api_meta/meta_deploy_running_tests.htm
  apexTestLevel: z
    .enum(['NoTestRun', 'RunLocalTests', 'RunAllTestsInOrg'])
    .optional()
    .describe(
      `Apex test level to use during deployment.

AGENT INSTRUCTIONS
Set this only if the user specifically ask to run apex tests in some of these ways:

NoTestRun="No tests are run"
RunLocalTests="Run all tests in the org, except the ones that originate from installed managed and unlocked packages."
RunAllTestsInOrg="Run all tests in the org, including tests of managed packages"

Don't set this param if "apexTests" is also set.
`
    ),
  apexTests: z
    .array(z.string())
    .describe(
      `Apex tests classes to run.

Set this param if the user ask an Apex test to be run during deployment.
`
    )
    .optional(),
  usernameOrAlias: usernameOrAliasParam,
  directory: directoryParam,
});

export type DeployMetadata = z.infer<typeof deployMetadataParams>;

/*
 * Deploy metadata to a Salesforce org.
 *
 * Parameters:
 * - sourceDir: Path to the local source files to deploy.
 * - manifest: Full file path for manifest (XML file) of components to deploy.
 * - checkOnly: Validate deployment without actually deploying to the org.
 * - apexTestLevel: Apex test level to use during deployment.
 * - apexTests: Apex tests classes to run.
 * - usernameOrAlias: Username or alias of the Salesforce org to deploy to.
 * - directory: Directory of the local project.
 *
 * Returns:
 * - textResponse: Deploy result.
 */
export const registerToolDeployMetadata = (server: SfMcpServer): void => {
  server.tool(
    'sf-deploy-metadata',
    `Deploy metadata to an org from your local project.

🆕 VALIDATION SUPPORT:
Use checkOnly=true to validate deployment without actually deploying (compilation check, syntax validation).

AGENT INSTRUCTIONS:
If the user doesn't specify what to deploy exactly ("deploy my changes"), leave the "sourceDir" and "manifest" params empty so the tool calculates which files to deploy.

For validation requests, set checkOnly=true.

EXAMPLE USAGE:
Deploy changes to my org
Deploy this file to my org
Validate my changes (checkOnly=true)
Check compilation errors in my code (checkOnly=true)
Deploy the manifest
Deploy X metadata to my org
Deploy X to my org and run A,B and C apex tests.
Dry-run deployment to check for errors (checkOnly=true)
`,
    deployMetadataParams.shape,
    {
      title: 'Deploy Metadata',
      destructiveHint: true,
      openWorldHint: false,
    },
    async ({ sourceDir, usernameOrAlias, apexTests, apexTestLevel, directory, manifest, checkOnly }) => {
      if (apexTests && apexTestLevel) {
        return textResponse("You can't specify both `apexTests` and `apexTestLevel` parameters.", true);
      }

      if (sourceDir && manifest) {
        return textResponse("You can't specify both `sourceDir` and `manifest` parameters.", true);
      }

      if (!usernameOrAlias)
        return textResponse(
          'The usernameOrAlias parameter is required, if the user did not specify one use the #sf-get-username tool',
          true
        );

      // needed for org allowlist to work
      process.chdir(directory);

      const connection = await getConnection(usernameOrAlias);
      const project = await SfProject.resolve(directory);

      const org = await Org.create({ connection });

      if (!sourceDir && !manifest && !(await org.tracksSource())) {
        return textResponse(
          'This org does not have source-tracking enabled or does not support source-tracking. You should specify the files or a manifest to deploy.',
          true
        );
      }

      let jobId: string = '';
      try {
        const stl = await SourceTracking.create({
          org,
          project,
          subscribeSDREvents: true,
        });

        const componentSet = await buildDeployComponentSet(connection, project, stl, sourceDir, manifest);

        if (componentSet.size === 0) {
          // STL found no changes
          const actionWord = checkOnly ? 'validate' : 'deploy';
          return textResponse(`No local changes to ${actionWord} were found.`);
        }

        // 🆕 AJOUT du support checkOnly dans les options de déploiement
        const deploy = await componentSet.deploy({
          usernameOrConnection: connection,
          apiOptions: {
            checkOnly: checkOnly || false,  // 👈 Paramètre clé ajouté !
            ...(apexTests ? { runTests: apexTests, testLevel: 'RunSpecifiedTests' } : {}),
            ...(apexTestLevel ? { testLevel: apexTestLevel } : {}),
          },
        });
        jobId = deploy.id ?? '';

        // polling freq. is set dynamically by SDR based on the component set size.
        const result = await deploy.pollStatus({
          timeout: Duration.minutes(10),
        });

        // 🆕 ANALYSE DÉTERMINISTE DES ERREURS
        const actionWord = checkOnly ? 'Validation' : 'Deploy';
        
        if (result.response.success) {
          const successMessage = checkOnly 
            ? 'Validation successful - no compilation errors found!' 
            : 'Deployment completed successfully!';
          return textResponse(`${actionWord} result: ${successMessage}`);
        }

        // Extraction et analyse structurée des erreurs
        const errorAnalysis = analyzeDeploymentErrors(result.response);
        
        return textResponse(
          `${actionWord} failed with ${errorAnalysis.errorCount} error(s):

${errorAnalysis.formattedErrors}

📊 ERROR SUMMARY:
${errorAnalysis.summary}

🔧 QUICK FIXES:
${errorAnalysis.suggestions}

Raw details: ${JSON.stringify(result.response.details, null, 2)}`, 
          true
        );
      } catch (error) {
        const err = SfError.wrap(error);
        const actionWord = checkOnly ? 'validation' : 'deployment';
        
        if (err.message.includes('timed out')) {
          return textResponse(
            `
YOU MUST inform the user that the ${actionWord} timed out and if they want to resume the ${actionWord}, they can use the #sf-resume tool
and ${jobId} for the jobId parameter.`,
            true
          );
        }
        return textResponse(`Failed to ${actionWord === 'validation' ? 'validate' : 'deploy'} metadata: ${err.message}`, true);
      }
    }
  );
};

async function buildDeployComponentSet(
  connection: Connection,
  project: SfProject,
  stl: SourceTracking,
  sourceDir?: string[],
  manifestPath?: string
): Promise<ComponentSet> {
  if (sourceDir || manifestPath) {
    return ComponentSetBuilder.build({
      apiversion: connection.getApiVersion(),
      sourceapiversion: ensureString((await project.resolveProjectConfig()).sourceApiVersion),
      sourcepath: sourceDir,
      ...(manifestPath
        ? {
            manifest: {
              manifestPath,
              directoryPaths: project.getUniquePackageDirectories().map((pDir) => pDir.fullPath),
            },
          }
        : {}),
      projectDir: stl?.projectPath,
    });
  }

  // No specific metadata requested to deploy, build component set from STL.
  const cs = (await stl.localChangesAsComponentSet(false))[0] ?? new ComponentSet(undefined, stl.registry);
  return cs;
}

// 🆕 FONCTION D'ANALYSE DÉTERMINISTE DES ERREURS
interface ErrorAnalysis {
  errorCount: number;
  formattedErrors: string;
  summary: string;
  suggestions: string;
  errorsByType: Map<string, any[]>;
  errorsByComponent: Map<string, any[]>;
}

function analyzeDeploymentErrors(response: any): ErrorAnalysis {
  const errors = [];
  const errorsByType = new Map<string, any[]>();
  const errorsByComponent = new Map<string, any[]>();

  // Extraction des différents types d'erreurs
  if (response.details?.componentFailures) {
    errors.push(...response.details.componentFailures);
  }
  
  if (response.details?.runTestResult?.failures) {
    errors.push(...response.details.runTestResult.failures);
  }

  if (response.details?.runTestResult?.codeCoverageWarnings) {
    errors.push(...response.details.runTestResult.codeCoverageWarnings);
  }

  // Groupement par type d'erreur
  errors.forEach(error => {
    const errorType = determineErrorType(error);
    const component = error.fullName || error.name || 'Unknown';
    
    if (!errorsByType.has(errorType)) {
      errorsByType.set(errorType, []);
    }
    errorsByType.get(errorType)!.push(error);
    
    if (!errorsByComponent.has(component)) {
      errorsByComponent.set(component, []);
    }
    errorsByComponent.get(component)!.push(error);
  });

  // Formatage des erreurs
  const formattedErrors = errors.map((error, index) => {
    const component = error.fullName || error.name || 'Unknown';
    const line = error.lineNumber ? `:${error.lineNumber}` : '';
    const column = error.columnNumber ? `:${error.columnNumber}` : '';
    
    return `${index + 1}. 📁 ${component}${line}${column}
   ❌ ${error.problem || error.message || 'Unknown error'}
   🔍 Type: ${determineErrorType(error)}`;
  }).join('\n\n');

  // Génération du résumé
  const summary = Array.from(errorsByType.entries())
    .map(([type, errs]) => `• ${type}: ${errs.length} error(s)`)
    .join('\n');

  // Suggestions basées sur les types d'erreurs
  const suggestions = generateSuggestions(errorsByType);

  return {
    errorCount: errors.length,
    formattedErrors,
    summary,
    suggestions,
    errorsByType,
    errorsByComponent
  };
}

function determineErrorType(error: any): string {
  const problem = (error.problem || error.message || '').toLowerCase();
  
  if (problem.includes('variable does not exist') || problem.includes('method does not exist')) {
    return 'REFERENCE_ERROR';
  }
  if (problem.includes('expecting') || problem.includes('syntax error')) {
    return 'SYNTAX_ERROR';
  }
  if (problem.includes('duplicate') || problem.includes('already exists')) {
    return 'DUPLICATE_ERROR';
  }
  if (problem.includes('required field') || problem.includes('missing')) {
    return 'MISSING_REQUIRED';
  }
  if (problem.includes('test') || problem.includes('assertion')) {
    return 'TEST_FAILURE';
  }
  if (problem.includes('coverage') || problem.includes('75%')) {
    return 'COVERAGE_WARNING';
  }
  if (problem.includes('permission') || problem.includes('access')) {
    return 'PERMISSION_ERROR';
  }
  if (problem.includes('limit') || problem.includes('exceeded')) {
    return 'LIMIT_EXCEEDED';
  }
  
  return 'OTHER_ERROR';
}

function generateSuggestions(errorsByType: Map<string, any[]>): string {
  const suggestions = [];
  
  if (errorsByType.has('SYNTAX_ERROR')) {
    suggestions.push('• Check syntax, missing semicolons, parentheses, or brackets');
  }
  
  if (errorsByType.has('REFERENCE_ERROR')) {
    suggestions.push('• Verify variable names, method signatures, and import statements');
  }
  
  if (errorsByType.has('DUPLICATE_ERROR')) {
    suggestions.push('• Remove duplicate declarations or rename conflicting elements');
  }
  
  if (errorsByType.has('TEST_FAILURE')) {
    suggestions.push('• Review test assertions and expected vs actual values');
  }
  
  if (errorsByType.has('COVERAGE_WARNING')) {
    suggestions.push('• Add more test methods or increase test coverage above 75%');
  }
  
  if (errorsByType.has('PERMISSION_ERROR')) {
    suggestions.push('• Check user permissions and field-level security settings');
  }

  if (errorsByType.has('MISSING_REQUIRED')) {
    suggestions.push('• Add missing required fields or provide default values');
  }
  
  return suggestions.length > 0 
    ? suggestions.join('\n') 
    : '• Review the error details above for specific guidance';
}
