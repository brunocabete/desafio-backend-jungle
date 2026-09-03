#!/bin/sh

set -e

echo "Creating SQS queues..."

aws sqs create-queue \
    --queue-name app-events

aws sqs create-queue \
    --queue-name app-events-dlq

echo "SQS queues created."