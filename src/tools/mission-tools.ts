import { Tool } from '@modelcontextprotocol/sdk/types.js';

export const missionTools: Tool[] = [
  {
    name: 'create_mission',
    description: 'Create a mission or task in the fleet mission ledger for cross-agent coordination',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Title or short summary of the mission' },
        description: { type: 'string', description: 'Detailed mission prompt or context' },
        originAgent: { type: 'string', description: 'Agent or user creating the mission (e.g. frea, mema, orchestrator, human)', default: 'agent' },
        targetAgent: { type: 'string', description: 'Target agent assigned to execute (e.g. frea, mema, any, human)', default: 'any' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], default: 'normal', description: 'Priority level' },
        payload: { type: 'object', description: 'Arbitrary input data or parameters for the mission' },
        database: { type: 'string', enum: ['project', 'central'], default: 'project', description: 'Target database (project or central)' }
      },
      required: ['title']
    }
  },
  {
    name: 'list_missions',
    description: 'Query missions from the fleet mission ledger filtered by status, agent, or target',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Specific mission ID to retrieve' },
        status: { type: 'string', enum: ['queued', 'claimed', 'in_progress', 'completed', 'failed', 'cancelled'], description: 'Filter by mission status' },
        targetAgent: { type: 'string', description: 'Filter by target agent' },
        originAgent: { type: 'string', description: 'Filter by origin agent' },
        claimedBy: { type: 'string', description: 'Filter by agent currently claiming the mission' },
        limit: { type: 'number', description: 'Maximum number of missions to return (default: 50, max: 200)' },
        offset: { type: 'number', description: 'Number of records to skip (default: 0)' },
        database: { type: 'string', enum: ['project', 'central'], default: 'project', description: 'Target database (project or central)' }
      }
    }
  },
  {
    name: 'update_mission',
    description: 'Update mission status, claim a mission, or report execution result/failure',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Mission ID to update' },
        status: { type: 'string', enum: ['queued', 'claimed', 'in_progress', 'completed', 'failed', 'cancelled'], description: 'New mission status' },
        claimedBy: { type: 'string', description: 'Agent claiming or executing the mission' },
        result: { type: 'object', description: 'Output data or result report upon completion' },
        error: { type: 'string', description: 'Error message if mission failed' },
        database: { type: 'string', enum: ['project', 'central'], default: 'project', description: 'Target database (project or central)' }
      },
      required: ['id']
    }
  }
];
