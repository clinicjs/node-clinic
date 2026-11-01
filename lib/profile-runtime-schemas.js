'use strict'

const Ajv2020 = require('ajv/dist/2020')
const addFormats = require('ajv-formats')
const reportSchema = require('../docs/schemas/performance-report.schema.json')
const runStatusSchema = require('../docs/schemas/run-status.schema.json')
const findingsPageSchema = require('../docs/schemas/mcp-findings-page.schema.json')
const responseEnvelopeSchema = require('../docs/schemas/mcp-response-envelope.schema.json')
const { validateReportSemantics } = require('./profile-semantic-validator')

const ajv = new Ajv2020({ allErrors: true, strict: false })
addFormats(ajv)

for (const schema of [reportSchema, runStatusSchema, findingsPageSchema, responseEnvelopeSchema]) {
  ajv.addSchema(schema)
}

const validateReport = ajv.getSchema(reportSchema.$id)
const validateRunStatus = ajv.getSchema(runStatusSchema.$id)
const validateFindingsPage = ajv.getSchema(findingsPageSchema.$id)
const validateEnvelope = ajv.getSchema(responseEnvelopeSchema.$id)

function errorsFor (validate, value) {
  if (validate(value)) return []
  return (validate.errors || []).map(error => ({
    path: error.instancePath || '/',
    message: error.message || 'schema validation failed'
  }))
}

function findingsPageSemanticErrors (page) {
  const errors = []
  const ids = new Set()
  for (const [index, finding] of page.items.entries()) {
    if (!finding || typeof finding !== 'object' || typeof finding.id !== 'string') continue
    if (ids.has(finding.id)) errors.push({ path: `/data/items/${index}/id`, message: 'finding IDs must be unique within a page' })
    ids.add(finding.id)
  }
  if (page.has_more !== (page.next_cursor !== null)) {
    errors.push({ path: '/data/next_cursor', message: 'next_cursor must be present exactly when has_more is true' })
  }
  if (page.truncated !== page.items.some(finding => finding && finding.truncated === true)) {
    errors.push({ path: '/data/truncated', message: 'truncated must reflect whether a finding was compacted' })
  }
  return errors
}

function validateToolResponse (tool, response) {
  const errors = errorsFor(validateEnvelope, response)
  if (errors.length || !response || response.ok !== true || !response.data) return errors

  const data = response.data
  if ((tool === 'get_profile_status' || tool === 'wait_profile_run') && data.schema_version === 1) {
    errors.push(...validatePerformanceReport(data).map(error => ({ ...error, path: `/data${error.path === '/' ? '' : error.path}` })))
  } else if ((tool === 'get_profile_status' || tool === 'wait_profile_run') && ['queued', 'running'].includes(data.status)) {
    errors.push(...errorsFor(validateRunStatus, data).map(error => ({ ...error, path: `/data${error.path === '/' ? '' : error.path}` })))
  } else if (tool === 'get_profile_findings' && Array.isArray(data.items)) {
    errors.push(...errorsFor(validateFindingsPage, data).map(error => ({ ...error, path: `/data${error.path === '/' ? '' : error.path}` })))
    errors.push(...findingsPageSemanticErrors(data))
  }

  return errors
}

function validatePerformanceReport (report) {
  return [
    ...errorsFor(validateReport, report),
    ...validateReportSemantics(report).map(error => ({ path: `/${error.path}`, message: error.message }))
  ]
}

module.exports = { validateToolResponse, validatePerformanceReport }
