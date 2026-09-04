#!/bin/sh

set -e

ENDPOINT="${AWS_ENDPOINT_URL:-http://localhost:4566}"

echo "Creating SQS queues..."

DLQ_URL=$(aws --endpoint-url "$ENDPOINT" sqs create-queue \
    --queue-name wager-transactions-dlq.fifo \
    --attributes FifoQueue=true \
    --query QueueUrl \
    --output text)

DLQ_ARN=$(aws --endpoint-url "$ENDPOINT" sqs get-queue-attributes \
    --queue-url "$DLQ_URL" \
    --attribute-names QueueArn \
    --query 'Attributes.QueueArn' \
    --output text)

cat > /tmp/main-queue-attributes.json <<EOF
{"FifoQueue":"true","ContentBasedDeduplication":"true","RedrivePolicy":"{\"deadLetterTargetArn\":\"$DLQ_ARN\",\"maxReceiveCount\":5}"}
EOF

aws --endpoint-url "$ENDPOINT" sqs create-queue \
    --queue-name wager-transactions.fifo \
    --attributes file:///tmp/main-queue-attributes.json

# Integration events outbox (Phase 4 item 5): the publisher sends envelopes here.
# Content-based dedup collapses identical duplicate publishes within the window
# (extra idempotence for consumers on top of the inbox pattern).
aws --endpoint-url "$ENDPOINT" sqs create-queue \
    --queue-name wager-events.fifo \
    --attributes FifoQueue=true,ContentBasedDeduplication=true

echo "SQS queues created: wager-transactions.fifo (main), wager-transactions-dlq.fifo (DLQ), wager-events.fifo (integration events)."
