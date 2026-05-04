import { Method, Receipt} from "mppx"
import * as Methods from "../Methods.js"

export function charge(parameters: charge.Parameters) {
	const {
		amount,
		currency,
		recipient,
		description,
		externalId,
		methodDetails,
	} = parameters;

	return Method.toServer(Methods.arbitrumCharge, {
		defaults: {
			currency,
			recipient,
			methodDetails
		} as never,

		async verify({ credential, request }) {
			const { challenge } = credential;
			const { chainId } = request.methodDetails

			console.log(challenge, request)
			throw new Error(`Error out on purpose to see if it retrieves info`)
			return {
				method: "arbitrum" as const,
				status: "success" as const,
				timestamp: new Date().toISOString(),
				reference: "0",
			};;
		}
	}
	)
}

export declare namespace charge {
	type Parameters = {
		amount?: string | undefined,
		currency?: string | undefined,
		recipient?: string | undefined,
		description?: string | undefined,
		externalId?: string | undefined,
		methodDetails?: {
			chainId?: number | undefined,
			permit2Address?: string | undefined,
			credentialTypes?: string[] | undefined,
			decimals?: number | undefined,
			splits?: string[] | undefined
		}
	}

}