import { FastifyRequest, FastifyReply } from "fastify";
import Bull, { Queue, Job } from "bull";
import { EcommerceCrawler } from "../services/crawlee.service.js";
import type { CrawlerConfig } from "../services/crawlee.service.js";

// Enum for job states for better type safety
enum JobStatus {
  PENDING = "pending",
  ACTIVE = "active",
  COMPLETED = "completed",
  FAILED = "failed",
  DELAYED = "delayed",
}

// Interface for job result
interface CrawlJobResult {
  crawlId: string;
  processedItems: number;
  metadata?: Record<string, any>;
}

// Enhanced error handling class
class CrawlJobError extends Error {
  constructor(
    public message: string,
    public code: string,
    public details?: Record<string, any>
  ) {
    super(message);
    this.name = "CrawlJobError";
  }
}

class CrawleeController {
  private queue: Queue;
  private static MAX_CONCURRENT_JOBS = 5;
  private static JOB_TIMEOUT = 2 * 60 * 60 * 1000; // 2 hours

  constructor() {
    this.queue = new Bull("crawlee-queue", {
      redis: {
        host: process.env.REDIS_HOST || "host.docker.internal",
        port: process.env.REDIS_PORT || "6379",
      },
      settings: {
        maxStalledCount: 3,
        stalledInterval: 30000, // 30 seconds
      },
      // Limit concurrent job processing
      limiter: {
        max: CrawleeController.MAX_CONCURRENT_JOBS,
        duration: 5000, // 5 seconds window
      },
    });

    this.setupQueueProcessing();
    this.setupErrorHandling();
  }

  private setupQueueProcessing() {
    this.queue.process(async (job: Job) => {
      // Set a timeout for long-running jobs
      job.opts.timeout = CrawleeController.JOB_TIMEOUT;

      console.log(`Processing job ${job.id} started`);

      try {
        // Validate job data
        const crawleeConfig: CrawlerConfig = job.data.config;
        if (!crawleeConfig) {
          throw new CrawlJobError(
            "Invalid crawler configuration",
            "INVALID_CONFIG",
            { jobData: job.data }
          );
        }

        // Create and run the crawler
        const crawler = new EcommerceCrawler(crawleeConfig);

        // Optional: Capture dataset
        const dataset = await crawler.run();

        // Generate a unique ID for this crawl
        const crawlId = await crawler.crawleeId();

        // Process dataset (example)
        const datasetItems = await dataset.getData();

        const result: CrawlJobResult = {
          crawlId,
          processedItems: datasetItems.length,
          metadata: {
            startedAt: job.timestamp,
            completedAt: Date.now(),
            config: crawleeConfig,
          },
        };

        console.log(`Job ${job.id} completed successfully`);
        return result;
      } catch (error) {
        // Enhanced error logging
        console.error(`Job ${job.id} processing error:`, error);

        // Throw a structured error for better tracking
        throw new CrawlJobError(
          error instanceof Error ? error.message : "Unknown crawl error",
          "CRAWL_FAILED",
          {
            originalError: error,
            jobId: job.id,
          }
        );
      }
    });
  }

  private setupErrorHandling() {
    // Comprehensive event listeners for job lifecycle
    this.queue.on("completed", (job, result) => {
      console.log(`Job ${job.id} completed`, {
        result,
        duration: Date.now() - job.timestamp,
      });
    });

    this.queue.on("failed", (job, error) => {
      console.error(`Job ${job.id} failed`, {
        error: error.message,
        stack: error.stack,
      });
    });

    this.queue.on("stalled", (job) => {
      console.warn(`Job ${job.id} stalled`, {
        attempts: job.attemptsMade,
      });
    });
  }

  public createCrawlee = async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      // Type and validation for crawler configuration
      const crawleeConfig: CrawlerConfig = req.body as CrawlerConfig;

      // Validate configuration
      this.validateCrawlerConfig(crawleeConfig);

      // Add job to queue with robust options
      const job = await this.queue.add(
        { config: crawleeConfig },
        {
          // Enhanced job resilience
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: 1000, // Initial delay of 1 second
          },
          removeOnComplete: 100, // Keep last 100 completed jobs
          removeOnFail: 200, // Keep last 200 failed jobs
        }
      );

      // Respond with detailed job information
      return {
        job_id: job.id,
        status: await job.getState(),
        message: "Crawlee job queued successfully",
        queuePosition: await this.queue.getJobCounts(),
      };
    } catch (error) {
      console.error("Error in createCrawlee:", error);

      // Differentiate between validation and processing errors
      if (error instanceof CrawlJobError) {
        return reply.status(400).send({
          error: error.code,
          message: error.message,
          details: error.details,
        });
      }

      return reply.status(500).send({
        error: "INTERNAL_ERROR",
        message: "Failed to create crawl job",
      });
    }
  };

  public getJobStatus = async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const { jobId } = req.params as { jobId: string };
      const job = await this.queue.getJob(jobId);

      if (!job) {
        return reply.status(404).send({ error: "Job not found" });
      }

      const state = await job.getState();
      const result = await job.returnvalue;

      return {
        job_id: job.id,
        state,
        result,
        progress: job.progress(), // Track job progress
        attempts: {
          total: job.attemptsMade,
          max: job.opts.attempts,
        },
      };
    } catch (error) {
      console.error("Error in getJobStatus:", error);
      return reply.status(500).send({
        error: "INTERNAL_ERROR",
        message: "Failed to retrieve job status",
      });
    }
  };

  // Additional method to validate crawler configuration
  private validateCrawlerConfig(config: CrawlerConfig) {
    if (!config) {
      throw new CrawlJobError(
        "Crawler configuration is required",
        "MISSING_CONFIG"
      );
    }

    // Add specific validation rules
    if (!config.urls || config.urls.length === 0) {
      throw new CrawlJobError(
        "At least one URL must be provided",
        "INVALID_URLS"
      );
    }

    // Add more specific validation as needed
  }

  // Optional: Method to list recent jobs
  public listRecentJobs = async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const { limit = 10 } = req.query as { limit?: number };

      // Get recent completed and failed jobs
      const completedJobs = await this.queue.getCompleted(0, limit);
      const failedJobs = await this.queue.getFailed(0, limit);

      return {
        completed: completedJobs.map((job) => ({
          id: job.id,
          timestamp: job.timestamp,
          result: job.returnvalue,
        })),
        failed: failedJobs.map((job) => ({
          id: job.id,
          timestamp: job.timestamp,
          error: job.failedReason,
        })),
      };
    } catch (error) {
      console.error("Error listing jobs:", error);
      return reply.status(500).send({
        error: "JOBS_LIST_ERROR",
        message: "Failed to retrieve job list",
      });
    }
  };
}

export default CrawleeController;
