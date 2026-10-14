import { createContext, useContext } from 'react'
import type { Profile } from '../types'

/**
 * The worker app's features the Super Admin can switch off for the Worker role (admin panel →
 * Roles & Permissions → Worker role). Doing checks and reporting exceptions are always on. The server
 * refuses a feature that is off as well; this only keeps its buttons and screens out of the way.
 */
export interface WorkerFeatures {
  /** Start a job on a machine. */
  startJobs: boolean
  /** End a job, hand it over. */
  changeJobs: boolean
  /** The worker's own performance and scores. */
  performance: boolean
  /** The worker's own check history. */
  history: boolean
}

const ALL_ON: WorkerFeatures = { startJobs: true, changeJobs: true, performance: true, history: true }

/** From the profile; a server that sends no permissions yet (older build) leaves everything on. */
export function featuresOf(profile: Profile): WorkerFeatures {
  const a = profile.actions
  if (!a) return ALL_ON
  return {
    startJobs: !!a.app_jobs?.create,
    changeJobs: !!a.app_jobs?.edit,
    performance: !!a.app_performance?.view,
    history: !!a.app_history?.view
  }
}

export const WorkerFeaturesContext = createContext<WorkerFeatures>(ALL_ON)
export const useWorkerFeatures = () => useContext(WorkerFeaturesContext)
