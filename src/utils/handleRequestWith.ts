import { Headers, headersToList } from 'headers-utils'
import {
  StartOptions,
  ResponseWithSerializedHeaders,
} from '../setupWorker/glossary'
import { MockedRequest, RequestHandler } from '../handlers/requestHandler'
import {
  ServiceWorkerMessage,
  createBroadcastChannel,
} from '../utils/createBroadcastChannel'
import { getResponse } from '../utils/getResponse'
import { getJsonBody } from './getJsonBody'
import { log } from './logger'

export const handleRequestWith = (
  requestHandlers: RequestHandler[],
  options: StartOptions,
) => {
  return async (event: MessageEvent) => {
    const channel = createBroadcastChannel(event)

    try {
      const message: ServiceWorkerMessage<MockedRequest> = JSON.parse(
        event.data,
        function (key, value) {
          if (key === 'url') {
            return new URL(value)
          }

          // Serialize headers
          if (key === 'headers') {
            return new Headers(value)
          }

          // Prevent empty fields from presering an empty value.
          // It's invalid to perform a GET request with { body: "" }
          if (value === '') {
            return undefined
          }

          return value
        },
      )

      const { type, payload: req } = message

      // Handle request body parsing outside of the worker's message parsing,
      // because a non set request body is sent over as an empty string.
      if (req.body) {
        // If the intercepted request's body has a JSON Content-Type
        // parse it into an object, otherwise leave as-is.
        const isJsonBody = req.headers.get('content-type')?.includes('json')

        req.body =
          isJsonBody && typeof req.body !== 'object'
            ? getJsonBody(req.body)
            : req.body
      }

      // Ignore worker irrelevant worker messages
      if (type !== 'REQUEST') {
        return null
      }

      const { response, handler } = await getResponse(req, requestHandlers)

      // Handle a scenario when there is no request handler
      // found for a given request.
      if (!handler) {
        return channel.send({ type: 'MOCK_NOT_FOUND' })
      }

      // Handle a scenario when there is a request handler,
      // but its response resolver didn't return any response.
      if (!response) {
        console.warn(
          '[MSW] Expected a mocking resolver function to return a mocked response Object, but got: %s. Original response is going to be used instead.',
          response,
        )

        return channel.send({ type: 'MOCK_NOT_FOUND' })
      }

      const responseWithSerializedHeaders: ResponseWithSerializedHeaders = {
        ...response,
        headers: headersToList(response.headers),
      }

      if (!options.quiet) {
        log(req, responseWithSerializedHeaders, handler)
      }

      channel.send({
        type: 'MOCK_SUCCESS',
        payload: responseWithSerializedHeaders,
      })
    } catch (error) {
      channel.send({
        type: 'INTERNAL_ERROR',
        payload: {
          status: 500,
          body: JSON.stringify({
            errorType: error.constructor.name,
            message: error.message,
            location: error.stack,
          }),
        },
      })
    }
  }
}