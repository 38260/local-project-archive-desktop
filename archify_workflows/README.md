# Archify Workflow Files for Local Project Archive Desktop

This directory contains all the Archify workflow JSON definition files and generated HTML visualization files created during the session.

## Files Included:

### Workflow JSON Definitions:
- rchify-dsh-workflow-final.json - Final version of the Local Project Archive Desktop workflow
- rchify-dsh-workflow-fixed.json - Fixed version with corrected mainPath
- rchify-dsh-workflow-mainpath-fixed.json - Version with corrected mainPath
- rchify-dsh-workflow-routing.json - Version with improved routing
- rchify-dsh-workflow-v2-attempt[1-3].json - Iterative attempts at creating v2 workflow
- rchify-dsh-workflow.json - Current working version
- project-workflow.json - Early architecture workflow attempt
- simple-archify-dsh-workflow*.json - Simplified workflow versions
- simple-workflow.json - Basic test workflow
- 	est-workflow*.json - Various test workflow files

### Generated HTML Visualizations:
- simple-workflow.html - Visualization of simple-workflow.json
- 	est-workflow*.html - Visualizations of test workflow files
- rchify-demo.html - Official Archify demo output

## Usage:
These files demonstrate the use of the Archify skill to create architecture, workflow, sequence, dataflow, and lifecycle diagrams for the Local Project Archive Desktop (¹é¼£Ê°¹â) application.

The workflow diagrams show:
- User interactions with the application
- Frontend/backend/system architecture
- Data flow between components
- Project management workflows
- Git analysis features
- Project launch and execution processes
- History tracking

All JSON files follow the Archify Workflow Schema v2 specification and can be rendered using:

ode archify/bin/archify.mjs render workflow <input.json> <output.html>
