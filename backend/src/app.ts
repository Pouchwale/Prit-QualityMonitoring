import fs from 'node:fs'
import path from 'node:path'
import express, { Router } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { config } from './config'
import { authenticate, requireRole } from './lib/auth'
import { masterData } from './lib/permissions'
import { errorHandler, notFound } from './lib/http'
import { authRouter } from './routes/auth'
import { departmentsRouter } from './routes/departments'
import { shiftsRouter } from './routes/shifts'
import { machinesRouter } from './routes/machines'
import { parametersRouter } from './routes/parameters'
import { activitiesRouter } from './routes/activities'
import { schedulesRouter } from './routes/schedules'
import { plantCalendarRouter } from './routes/plantCalendar'
import { calendarYearsRouter, weeklyRulesRouter } from './routes/calendarYears'
import { usersRouter } from './routes/users'
import { monitoringRouter } from './routes/monitoring'
import { workerRouter } from './routes/worker'
import { accessRouter } from './routes/access'
import { HttpError } from './lib/http'
import { serveSignedMedia } from './lib/mediaLinks'

export function createApp() {
  const app = express()
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))
  // Browsers ignore (and warn about) these on plain HTTP; send them only over HTTPS.
  app.use((req, res, next) => {
    if (!req.secure) {
      res.removeHeader('Cross-Origin-Opener-Policy')
      res.removeHeader('Origin-Agent-Cluster')
    }
    next()
  })
  // Expose Content-Disposition so the admin site (another origin) can read download filenames.
  app.use(cors({ exposedHeaders: ['Content-Disposition'] }))
  app.use(express.json({ limit: '1mb' }))

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true })
  })

  // Evidence files: only through signed, short-lived links handed out by permission-checked APIs.
  serveSignedMedia(app)

  serveWorkerWebApp(app)

  app.use('/api/auth', authRouter)

  // Worker mobile app
  app.use('/api/worker', authenticate, requireRole('WORKER'), workerRouter)

  // Admin panel. Every route checks the signed-in user's module permissions (lib/permissions.ts).
  // Master-data lists may be read by any module whose page uses them as a dropdown;
  // changing them needs "manage" on the owning module.
  const admin = Router()
  admin.use(authenticate, (req, _res, next) =>
    req.user!.role === 'WORKER' ? next(new HttpError(403, 'This account cannot use the admin panel')) : next()
  )
  admin.use('/departments', masterData('departments', ['machines', 'parameters', 'activities', 'workers', 'checks', 'exceptions', 'reports']), departmentsRouter)
  admin.use('/shifts', masterData('shifts', ['schedules', 'workers', 'checks', 'exceptions', 'reports']), shiftsRouter)
  admin.use('/machines', masterData('machines', ['activities', 'schedules', 'workers', 'assignments', 'checks', 'exceptions', 'reports']), machinesRouter)
  admin.use('/parameters', masterData('parameters', ['activities']), parametersRouter)
  admin.use('/activities', masterData('activities', ['machines', 'schedules', 'checks', 'exceptions', 'reports']), activitiesRouter)
  admin.use('/schedules', masterData('schedules', ['assignments']), schedulesRouter)
  admin.use('/plant-closures', plantCalendarRouter)
  admin.use('/calendar-years', calendarYearsRouter)
  admin.use('/weekly-rules', weeklyRulesRouter)
  admin.use('/users', usersRouter)
  admin.use('/access', accessRouter)
  admin.use('/', monitoringRouter)
  app.use('/api', admin)

  app.use((_req, _res, next) => next(notFound('Endpoint')))
  app.use(errorHandler)
  return app
}

/**
 * The worker web app (PWA) for iPhone, Android browsers and PCs, served from the backend at
 * /app so it shares the API's address, login and HTTPS certificate. It is the same Expo code
 * as the Android app, exported for the web.
 */
function serveWorkerWebApp(app: express.Express) {
  const dir = config.workerWebDir
  const index = path.join(dir, 'index.html')
  // Checked per request, so a build finishing after the backend started is picked up.
  const built = () => fs.existsSync(index)
  if (!built()) console.log(`Worker web app not built yet (${dir}); run "npm run build:web" in worker-mobile`)

  // The app shows captured photos and videos from blob: URLs and talks only to this server.
  const csp = helmet.contentSecurityPolicy({
    useDefaults: true,
    directives: {
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:', 'blob:'],
      'media-src': ["'self'", 'blob:'],
      'connect-src': ["'self'"],
      'worker-src': ["'self'"],
      'manifest-src': ["'self'"],
      'upgrade-insecure-requests': null
    }
  })

  app.get('/', (_req, res) => res.redirect('/app/'))
  app.use(
    '/app',
    csp,
    express.static(dir, {
      index: false,
      setHeaders: (res, file) => {
        const name = path.basename(file)
        // The service worker and manifest must update as soon as a new version is deployed.
        if (name === 'sw.js' || name === 'manifest.json') res.setHeader('Cache-Control', 'no-cache')
        else if (file.includes(`${path.sep}_expo${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      }
    })
  )
  // Any other /app path is a screen inside the app.
  app.get(['/app', '/app/{*rest}'], csp, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache')
    if (!built()) {
      res.status(503).type('text/plain').send('The worker web app is being built. Try again in a minute.')
      return
    }
    res.sendFile(index)
  })
}
